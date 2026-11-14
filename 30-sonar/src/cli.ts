#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { explain, moveUsd, type Context } from "./explain.js";
import { history } from "./history.js";
import { explorer, pharos, prosUsd } from "./pharos.js";
import { build, markdown, storyLines, text } from "./report.js";
import { discover, parseList } from "./whales.js";

const HELP = `sonar: watches a list of Pharos mainnet wallets and explains their big moves

  sonar discover [--count 7] [--active-hours 48] [--out <file>]
        pick whales: the biggest PROS holders on pharosscan that are wallets and moved lately
  sonar report [--hours 24] [--md <file>] [--json <file>]
        holdings now, every move in the window, the significant ones explained, one summary line
  sonar watch [--every 300]
        report once, then every N seconds print only new significant moves

  --list <file>   the watch list (default: whales.json in sonar's folder)
  --home <dir>    sonar's folder (default: SONAR_HOME, or %APPDATA%\\sonar / ~/.config/sonar)

A move is significant when it is worth at least "minUsd" (whole list, or per whale) at the PROS/USD feed price.`;

const argv = process.argv.slice(2);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
const flags = ["--count", "--active-hours", "--out", "--hours", "--md", "--json", "--every", "--list", "--home"];
const command = argv.find((a, i) => !a.startsWith("--") && !flags.includes(argv[i - 1]));
const home = opt("--home") ?? process.env.SONAR_HOME ?? join(process.platform === "win32" && process.env.APPDATA ? process.env.APPDATA : process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "sonar");
const listPath = opt("--list") ?? join(home, "whales.json");
const stamp = () => `[${new Date().toISOString()}]`;

function write(file: string, body: string) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

function list() {
  if (!existsSync(listPath)) throw new Error(`no watch list at ${listPath}. Run sonar discover, or pass --list <file>`);
  return parseList(readFileSync(listPath, "utf8"));
}

async function main(): Promise<number> {
  if (!command || argv.includes("--help") || argv.includes("-h")) return console.log(HELP), 0;
  const client = pharos();
  const get = explorer();

  if (command === "discover") {
    const found = await discover(get, Number(opt("--count") ?? 7), Number(opt("--active-hours") ?? 48));
    const out = opt("--out") ?? listPath;
    console.log(found.note);
    for (const w of found.whales) console.log(`  ${w.address}  ${w.label}`);
    if (found.whales.length < 5) console.log(`only ${found.whales.length} found; try a larger --active-hours`);
    write(out, JSON.stringify({ minUsd: found.minUsd, whales: found.whales }, null, 2) + "\n");
    console.log(`saved to ${out} (edit labels and minUsd freely)`);
    return 0;
  }

  if (command === "report") {
    const l = list();
    const hours = Number(opt("--hours") ?? 24);
    const r = await build(client, get, l, hours, await prosUsd(client));
    console.log(text(r));
    if (opt("--md")) write(opt("--md")!, markdown(r)), console.log(`\nmarkdown: ${opt("--md")}`);
    if (opt("--json")) write(opt("--json")!, JSON.stringify(r, null, 2)), console.log(`json: ${opt("--json")}`);
    return 0;
  }

  if (command === "watch") {
    const l = list();
    const every = Math.max(60, Number(opt("--every") ?? 300));
    const seenFile = join(home, "seen.json");
    const seen = new Set<string>(existsSync(seenFile) ? (JSON.parse(readFileSync(seenFile, "utf8")) as string[]) : []);
    const first = await build(client, get, l, Number(opt("--hours") ?? 24), await prosUsd(client));
    console.log(text(first));
    for (const w of first.whales) for (const s of w.stories) seen.add(s.move.hash);
    write(seenFile, JSON.stringify([...seen].slice(-5000)));
    console.log(`\n${stamp()} watching ${l.whales.length} whales, a look every ${every} s. Ctrl+C to stop.`);
    let stop = false;
    process.on("SIGINT", () => (stop = true));
    let since = new Date().toISOString();
    while (!stop) {
      for (let t = 0; t < every * 10 && !stop; t++) await new Promise((r) => setTimeout(r, 100));
      if (stop) break;
      try {
        const pros = await prosUsd(client);
        const ctx: Context = { client, get, pros: pros.price, watched: new Map(l.whales.map((w) => [w.address, w])) };
        // look a few minutes further back than the last round: the explorer can lag the chain a little
        const from = new Date(Date.parse(since) - 600_000).toISOString();
        since = new Date().toISOString();
        let fresh = 0;
        for (const w of l.whales) {
          for (const m of await history(get, w.address, from)) {
            if (seen.has(m.hash) || (moveUsd(m, pros.price) ?? 0) < (w.minUsd ?? l.minUsd)) continue;
            seen.add(m.hash);
            fresh++;
            const s = await explain(ctx, w, m);
            console.log(`${stamp()} ${w.label} ${s.whale.address}`);
            for (const line of storyLines(s)) console.log(line);
          }
        }
        write(seenFile, JSON.stringify([...seen].slice(-5000)));
        console.log(`${stamp()} looked again: ${fresh} new significant move${fresh === 1 ? "" : "s"}`);
      } catch (e) {
        console.log(`${stamp()} this look failed (${(e as Error).message.split("\n")[0]}); trying again next time`);
      }
    }
    return 0;
  }

  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`sonar: ${(e as Error).message.split("\n")[0]}`);
    process.exit(1);
  },
);
