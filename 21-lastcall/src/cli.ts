#!/usr/bin/env node
// lastcall: a liquidation watchdog for lending positions on Pharos mainnet. It reads, it rehearses, it shouts.
// It never signs or sends a transaction: the repay or top-up it suggests is for the borrower to do.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import { RpcChain } from "./chain.js";
import { ENV_KEYS, HOME, ensureEnvTemplate, findTelegramChat, hide, loadSecrets, shout, type Outlet } from "./deliver.js";
import { DEFAULT_THRESHOLDS, checkThresholds, type Thresholds } from "./health.js";
import { lookAt } from "./look.js";
import { alertText, stamp, table } from "./render.js";
import { recentBorrowers } from "./scan.js";
import { AAVE_POOLS, MORPHO_MARKETS } from "./venues.js";
import { emptyState, replayRules, watchRound, type WatchState } from "./watch.js";

const HELP = `lastcall: a liquidation watchdog for Pharos lending (Morpho Blue, Avalon, OpenFi, Zona).

  lastcall look --wallet 0x... [--wallet 0x...] [thresholds] [--block N] [--json out.json]
      every loan the wallet has, its level, how far the price can fall, how many days the carry leaves,
      and a repay / top-up rehearsed on the real contracts
  lastcall watch --wallet 0x... [thresholds] [--every 60] [--rounds N] [--telegram] [--discord]
      the same every --every seconds; alerts on a worse level, a recovery, a short clock or a rule change
  lastcall replay --pool avalon --wallet 0x... --block N [--telegram] [--discord]
      the rules alert lastcall would have sent for a change that already happened in block N
  lastcall scan [--hours 24] [--top 15]
      borrowers seen in the last hours on every venue, ranked by health
  lastcall channels [test]
      where alerts go; "test" sends a test message (and finds your Telegram chat after you /start the bot)

thresholds: --warn 1.3 --critical 1.1 --target 1.5 --rearm 0.02 --days-warn 30
            (--days-warn: alert when the carry leaves fewer days than this, even with a healthy-looking factor)
extra Morpho markets: --market 0x<id> (repeatable). Public RPC: https://rpc.pharos.xyz, PHAROS_RPC_URL overrides.
secrets: ${HOME}/.env (${ENV_KEYS.telegramToken}, ${ENV_KEYS.telegramChat}, ${ENV_KEYS.discordWebhook}), LASTCALL_HOME moves it.`;

class Exit extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

function parse(argv: string[]) {
  const flags = new Map<string, string[]>();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      const v = next !== undefined && !next.startsWith("--") ? (i++, next) : "true";
      flags.set(k, [...(flags.get(k) ?? []), v]);
    } else words.push(a);
  }
  const one = (k: string) => flags.get(k)?.at(-1);
  const num = (k: string, d: number) => {
    const v = one(k);
    if (v === undefined) return d;
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Exit(2, `--${k} wants a number, got "${v}"`);
    return n;
  };
  const addrs = (k: string, len: number) => (flags.get(k) ?? []).map((v) => {
    if (!new RegExp(`^0x[0-9a-fA-F]{${len}}$`).test(v)) throw new Exit(2, `--${k} ${v} doesn't look like a ${len === 40 ? "wallet address" : "market id"}`);
    return v as Hex;
  });
  return { words, flags, one, num, addrs };
}

function thresholds(p: ReturnType<typeof parse>): Thresholds {
  const t = { warn: p.num("warn", DEFAULT_THRESHOLDS.warn), critical: p.num("critical", DEFAULT_THRESHOLDS.critical), target: p.num("target", DEFAULT_THRESHOLDS.target), rearm: p.num("rearm", DEFAULT_THRESHOLDS.rearm) };
  const bad = checkThresholds(t);
  if (bad) throw new Exit(2, bad);
  return t;
}

const say = (s: string) => process.stdout.write(`${s}\n`);
const note = (s: string) => process.stderr.write(`${s}\n`);
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v === Infinity ? "Infinity" : v), 2);

function outlet(p: ReturnType<typeof parse>): Outlet {
  return { console: say, net: fetch, secrets: loadSecrets(), telegram: p.one("telegram") === "true", discord: p.one("discord") === "true" };
}

function loadState(path: string): WatchState {
  if (!existsSync(path)) return emptyState();
  return { ...emptyState(), ...JSON.parse(readFileSync(path, "utf8")) };
}

async function main(argv: string[]): Promise<void> {
  const p = parse(argv);
  const cmd = p.words[0];
  const chain = new RpcChain();
  if (!cmd || cmd === "help" || p.one("help")) {
    say(HELP);
    return;
  }

  if (cmd === "look") {
    const wallets = p.addrs("wallet", 40);
    if (!wallets.length) throw new Exit(2, "look needs --wallet 0x...");
    const t = thresholds(p);
    const daysWarn = p.num("days-warn", 30);
    const at = p.one("block") ? p.num("block", 0) : undefined;
    const started = Date.now();
    const r = await lookAt(chain, wallets, t, daysWarn, at, p.addrs("market", 64));
    say(`${stamp(new Date(r.time * 1000))} block ${r.block}: ${r.out.length} loan(s) for ${wallets.length} wallet(s); warn ${t.warn}, critical ${t.critical}, target ${t.target}, clock alert under ${daysWarn} days`);
    if (r.out.length === 0) say("no open loans on Avalon, OpenFi, Zona or the known Morpho markets for these wallets");
    else {
      say(table(r.out));
      for (const a of r.out) say(`\n${alertText(a)}`);
    }
    note(`(${chain.requests} reads, ${((Date.now() - started) / 1000).toFixed(1)} s)`);
    const out = p.one("json");
    if (out) writeFileSync(out, json({ block: r.block, time: r.time, thresholds: t, daysWarn, loans: r.out }));
    return;
  }

  if (cmd === "watch") {
    const wallets = p.addrs("wallet", 40);
    if (!wallets.length) throw new Exit(2, "watch needs --wallet 0x...");
    const t = thresholds(p);
    const daysWarn = p.num("days-warn", 30);
    const every = p.num("every", 60);
    const rounds = p.num("rounds", Infinity);
    mkdirSync(HOME, { recursive: true });
    const statePath = p.one("state") ?? join(HOME, "state.json");
    const state = loadState(statePath);
    const o = outlet(p);
    note(`watching ${wallets.length} wallet(s) every ${every} s; state in ${statePath}; channels: console${o.telegram ? ", telegram" : ""}${o.discord ? ", discord" : ""}`);
    for (let i = 1; i <= rounds; i++) {
      const started = Date.now();
      try {
        const { alerts, look } = await watchRound(chain, wallets, t, daysWarn, state, p.addrs("market", 64));
        for (const a of alerts) for (const line of await shout(o, a.text)) say(`  ${line}`);
        const quiet = look.out.map((a) => `${a.loan.snap.venue} ${a.loan.snap.hf.toFixed(4)} ${state.levels[a.key]}`).join(", ");
        note(`${stamp()} round ${i} at block ${look.block}: ${alerts.length} alert(s)${alerts.length ? "" : `, all as before (${quiet || "no loans"})`}`);
        writeFileSync(statePath, json(state));
      } catch (e) {
        // A flaky read shouldn't kill an overnight watch; say so and try again next round.
        note(`${stamp()} round ${i} failed: ${(e as Error).message}`);
      }
      if (i < rounds) await new Promise((r) => setTimeout(r, Math.max(0, every * 1000 - (Date.now() - started))));
    }
    return;
  }

  if (cmd === "replay") {
    const [wallet] = p.addrs("wallet", 40);
    const pool = p.one("pool");
    const block = p.num("block", NaN);
    if (!wallet || !pool || !Number.isInteger(block)) throw new Exit(2, `replay needs --pool <${AAVE_POOLS.map((x) => x.key).join("|")}> --wallet 0x... --block N`);
    const text = await replayRules(chain, pool, wallet, block, thresholds(p), p.num("days-warn", 30));
    const ts = await chain.timestamp(block);
    for (const line of await shout(outlet(p), text, new Date(ts * 1000))) say(`  ${line}`);
    return;
  }

  if (cmd === "scan") {
    const hours = p.num("hours", 24);
    const top = p.num("top", 15);
    const head = await chain.head();
    const t0 = await chain.timestamp(head);
    const t1 = await chain.timestamp(head - 100_000);
    const blocks = Math.round((hours * 3600 * 100_000) / Math.max(1, t0 - t1));
    note(`looking for Borrow events in the last ${hours} h (${blocks} blocks, ${Math.ceil(blocks / 999)} log windows)`);
    const found = await recentBorrowers(chain, head, blocks, (d, n) => { if (d % 50 === 0 || d === n) note(`  ${d}/${n} windows`); });
    const wallets = [...new Set(found.map((b) => b.wallet.toLowerCase()))] as Hex[];
    const markets = [...new Set(found.map((b) => b.market).filter((m): m is Hex => !!m && !MORPHO_MARKETS.includes(m)))];
    note(`${found.length} borrow(s) by ${wallets.length} wallet(s); reading their loans`);
    const t = thresholds(p);
    const r = await lookAt(chain, wallets, t, p.num("days-warn", 30), head, markets);
    const ranked = [...r.out].sort((a, b) => a.loan.snap.hf - b.loan.snap.hf).slice(0, top);
    say(`${stamp(new Date(r.time * 1000))} block ${r.block}: ${r.out.length} open loan(s) among borrowers of the last ${hours} h`);
    say(table(ranked));
    return;
  }

  if (cmd === "channels") {
    const env = ensureEnvTemplate();
    const s = loadSecrets();
    say(`secrets file: ${env}`);
    say(`telegram: bot token ${s.telegramToken ? "filled" : "empty"}, chat id ${s.telegramChat ? "filled" : "empty"}`);
    say(`discord: webhook ${s.discordWebhook ? "filled" : "empty"}`);
    if (p.words[1] !== "test") return;
    if (s.telegramToken && !s.telegramChat) {
      const chat = await findTelegramChat(fetch, s.telegramToken).catch((e: Error) => { say(hide(e.message, s)); return null; });
      if (!chat) say("telegram: no /start message found; open your bot in Telegram, press Start, then run this again");
      else {
        const text = readFileSync(env, "utf8").replace(new RegExp(`^${ENV_KEYS.telegramChat}=.*$`, "m"), `${ENV_KEYS.telegramChat}=${chat}`);
        writeFileSync(env, text);
        s.telegramChat = chat;
        say("telegram: found your chat and saved its id");
      }
    }
    const o: Outlet = { console: say, net: fetch, secrets: s, telegram: !!s.telegramToken, discord: !!s.discordWebhook };
    for (const line of await shout(o, "lastcall test: if you can read this, alerts will reach you here.")) say(`  ${line}`);
    return;
  }

  throw new Exit(2, `unknown command "${cmd}"\n\n${HELP}`);
}

main(process.argv.slice(2)).catch((e) => {
  if (e instanceof Exit) {
    note(e.message);
    process.exit(e.code);
  }
  note(`lastcall stopped: ${(e as Error).message}`);
  process.exit(1);
});
