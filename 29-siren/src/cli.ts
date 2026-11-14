#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Alert } from "./alert.js";
import { channels, ensureEnv, envFile, findChat, readSecrets, redact, setSecret } from "./deliver.js";
import { EXAMPLE_RULES } from "./example.js";
import { flush } from "./outbox.js";
import { FEED_ABI, RPC_URL, addressLink, pharos } from "./pharos.js";
import { RuleError, describe, loadRules } from "./rules.js";
import { homeDir, loadState, saveState } from "./state.js";
import { round } from "./watch.js";

const HELP = `siren: watches Pharos mainnet and tells you on Telegram or Discord when your rule matches

  siren init                      make siren's folder: .env for the channels and an example rules.json
  siren connect                   after you sent /start to your bot: find your chat and save it
  siren test                      send one test message to every channel you set up
  siren rules                     load the rules, check them on chain, show what each one watches
  siren watch [--since <blocks>] [--once] [--console-only]
                                  watch until stopped. --since looks back that many blocks on the first run
  siren status                    where siren stopped, what is still waiting to be sent

  --rules <file>    rules file (default: rules.json in siren's folder)
  --home <dir>      siren's folder (default: SIREN_HOME, or %APPDATA%\\siren / ~/.config/siren)

Secrets (bot token, webhook) live only in <siren's folder>/.env or the environment. siren never prints them.`;

const argv = process.argv.slice(2);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const command = argv.find((a, i) => !a.startsWith("--") && !["--rules", "--home", "--since"].includes(argv[i - 1]));
const home = opt("--home") ?? homeDir();
const rulesPath = opt("--rules") ?? join(home, "rules.json");
const statePath = join(home, "state.json");
const stamp = () => `[${new Date().toISOString()}]`;

async function rules() {
  if (!existsSync(rulesPath)) throw new RuleError(`no rules file at ${rulesPath}. Run siren init, or pass --rules <file>`);
  return loadRules(readFileSync(rulesPath, "utf8"), pharos());
}

async function main(): Promise<number> {
  if (!command || argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;
  const secrets = readSecrets(home);

  if (command === "init") {
    const env = ensureEnv(home);
    console.log(`${env.created ? "made" : "kept"} ${env.path}`);
    if (!existsSync(rulesPath)) writeFileSync(rulesPath, EXAMPLE_RULES);
    console.log(`rules: ${rulesPath}`);
    console.log(`Open the .env, paste your Telegram bot token and/or Discord webhook URL, save. Then: siren connect (Telegram), siren test.`);
    return 0;
  }

  if (command === "connect") {
    if (!secrets.telegramToken) return console.error(`no SIREN_TELEGRAM_BOT_TOKEN in ${envFile(home)} (run siren init first)`), 2;
    const chat = await findChat(fetch, secrets.telegramToken);
    if (!chat) return console.error(`your bot has no /start message yet. Open the bot in Telegram, send /start, run this again.`), 2;
    setSecret(home, "SIREN_TELEGRAM_CHAT_ID", chat);
    console.log(`saved chat ${chat} to ${envFile(home)}`);
    return 0;
  }

  if (command === "test") {
    const chans = channels(secrets);
    if (!chans.length) return console.error(`no channel set up in ${envFile(home)}`), 2;
    const now = new Date().toISOString();
    const a: Alert = { id: `test:${now}`, rule: "test", kind: "call", title: "siren test message", value: "channels work", facts: [["rpc", RPC_URL]], links: [["explorer", addressLink("0x0000000000000000000000000000000000000000")]], at: now };
    let bad = 0;
    for (const c of chans) {
      try {
        await c.send(a);
        console.log(`  ✓ ${c.name}`);
      } catch (e) {
        bad++;
        console.log(`  ✗ ${c.name}: ${redact((e as Error).message, secrets)}${"hint" in (e as object) ? ` (${(e as { hint: string }).hint})` : ""}`);
      }
    }
    return bad ? 2 : 0;
  }

  if (command === "rules") {
    const cfg = await rules();
    console.log(`${rulesPath}: ${cfg.rules.length} rules, a round every ${cfg.pollSeconds} s`);
    const client = pharos();
    for (const r of cfg.rules) {
      let now = "";
      if (r.kind === "price") {
        const [, answer, , updatedAt] = await client.readContract({ address: r.feed, abi: FEED_ABI, functionName: "latestRoundData" });
        now = `  (now $${(Number(answer) / 10 ** r.decimals).toFixed(4)}, updated ${new Date(Number(updatedAt) * 1000).toISOString()})`;
      }
      console.log(`  ${r.name.padEnd(20)} ${describe(r)}${now}`);
    }
    return 0;
  }

  if (command === "status") {
    const s = loadState(statePath);
    console.log(`state: ${statePath}`);
    console.log(`  read up to block ${s.lastBlock ?? "(not started)"}`);
    console.log(`  events already alerted: ${Object.keys(s.seen).length}`);
    console.log(`  waiting to be sent: ${s.outbox.length}`);
    for (const [k, v] of Object.entries(s.price)) console.log(`  ${k}: ${v.armed ? "armed" : "fired, waits for the price to come back"}${v.last !== undefined ? `, last $${v.last.toFixed(4)}` : ""}`);
    return 0;
  }

  if (command === "watch") {
    const cfg = await rules();
    // --console-only means what it says even when a channel is set up: a look back that only prints
    const consoleOnly = argv.includes("--console-only");
    const chans = consoleOnly ? [] : channels(secrets);
    if (!chans.length && !consoleOnly) return console.error(`no Telegram or Discord set up in ${envFile(home)}. Run siren init, or add --console-only`), 2;
    const state = loadState(statePath);
    const since = BigInt(opt("--since") ?? "0");
    console.log(`${stamp()} siren watching Pharos mainnet with ${cfg.rules.length} rules -> ${chans.map((c) => c.name).join(" + ") || "console only"}`);
    for (const r of cfg.rules) console.log(`  ${r.name}: ${describe(r)}`);
    const ctx = { client: pharos(), net: fetch, cfg, state, say: (l: string) => console.log(`${stamp()} ${l}`) };
    let stop = false;
    process.on("SIGINT", () => {
      stop = true;
      console.log(`${stamp()} stopping after this round`);
    });
    for (let first = true; !stop; first = false) {
      try {
        const r = await round(ctx, first && !state.lastBlock ? since : 0n);
        const f = await flush(state, chans, (l) => console.log(l));
        saveState(statePath, state);
        const span = r.from <= r.to ? `blocks ${r.from}-${r.to}` : `block ${r.to}`;
        console.log(`${stamp()} ${span}: ${r.queued} new alert${r.queued === 1 ? "" : "s"}${r.found > r.queued ? `, ${r.found - r.queued} already sent before` : ""}${f.sent ? `, ${f.sent} ${chans.length ? "delivered" : "printed"}` : ""}${f.waiting ? `, ${f.waiting} waiting` : ""}`);
        for (const p of f.problems) console.log(`${stamp()} ${redact(p, secrets)}`);
      } catch (e) {
        saveState(statePath, state);
        console.log(`${stamp()} round failed: ${redact((e as Error).message.split("\n")[0], secrets)}; same blocks again next round`);
      }
      if (argv.includes("--once")) break;
      for (let t = 0; t < cfg.pollSeconds * 10 && !stop; t++) await new Promise((res) => setTimeout(res, 100));
    }
    return 0;
  }

  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`siren: ${redact((e as Error).message.split("\n")[0], readSecrets(home))}`);
    process.exit(1);
  },
);

