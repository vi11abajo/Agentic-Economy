#!/usr/bin/env node
// prosArbitrage: scans the PROS price on Faroswap (Pharos) and on OKX, Bitget and MEXC, nets out every cost,
// and only acts when a route still pays after them. Acting is simulated: the DEX leg is a real swap run inside
// eth_call, the CEX leg an order payload. Nothing is sent and no keys are needed.
// Exit codes: 0 scanned (ACT or SKIP), 1 error, 2 bad input.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Exchange } from "./cex.js";
import { client } from "./chain.js";
import { apply, displayPath, homeDir, load, save, type Settings } from "./config.js";
import { pct, type RouteResult } from "./routes.js";
import { scan, type Scan } from "./scan.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const HELP = `prosArbitrage: PROS on Faroswap (Pharos) vs OKX, Bitget and MEXC. Acts only when it pays after all costs.

  prosarb scan [--size USD] [--top N] [--json]   one scan of every source, every route, and the decision
  prosarb watch [--every SEC] [--count N] [--full]  scan again and again (default every 60 s): one line
                                                 per scan, the whole scan for an ACT or with --full
  prosarb config                                 show the settings
  prosarb config set k=v [k=v ...]               min_net_usd, min_net_pct, sizes_usd=50,200,1000,
                                                 rebalance=on|off, okx.taker_pct, mexc.withdraw_pros, ...
  prosarb log [--last N]                         the last scans from the log

Every scan is appended to ${displayPath(join(homeDir(), "scans.jsonl"))}. Nothing is ever sent.`;

function flags(argv: string[]) {
  const pos: string[] = [];
  const f = { json: false, full: false, size: undefined as number | undefined, top: 8, every: 60, count: Infinity, last: 10, only: undefined as Exchange[] | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const num = () => {
      const n = Number(argv[++i]);
      if (!(n > 0)) throw new Exit(2, `${a} needs a positive number`);
      return n;
    };
    if (a === "--json") f.json = true;
    else if (a === "--full") f.full = true;
    else if (a === "--size") f.size = num();
    else if (a === "--top") f.top = num();
    else if (a === "--every") f.every = num();
    else if (a === "--count") f.count = num();
    else if (a === "--last") f.last = num();
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

const usd = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(Math.abs(x) < 10 ? 3 : 2)}`;
const utc = (iso: string) => iso.replace("T", " ").replace(/\.\d+Z$/, " UTC");

function table(rows: string[][], right: number[] = []): string[] {
  const w = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
  return rows.map((r) => `  ${r.map((c, i) => (right.includes(i) ? c.padStart(w[i]) : c.padEnd(w[i]))).join("  ")}`.trimEnd());
}

export function render(sc: Scan, top: number): string {
  const o = sc.oracles;
  const out = [
    `prosArbitrage · scan · block ${sc.block.toLocaleString("en-US")} · ${utc(sc.at)}`,
    `oracles (Chainlink on Pharos, ${Math.round(o.ageSec / 60)} min old): PROS ${o.prosUsd.toFixed(5)} · USDC ${o.usdcUsd.toFixed(5)} · USDT ${o.usdtUsd.toFixed(5)} · gas ${o.baseFeeGwei} gwei`,
    "",
    ...table([["source", "bid $", "ask $", "vs oracle", "detail"], ...sc.sources.map((s) => [s.id, s.bidUsd.toFixed(5), s.askUsd.toFixed(5), pct(s.gapPct, 2), s.detail])], [1, 2, 3]),
  ];
  if (sc.skipped.length) out.push(`  left out: ${sc.skipped.join("; ")}`);
  const ranked = [...sc.routes].sort((a, b) => b.netUsd - a.netUsd).slice(0, top);
  out.push(
    "",
    `best ${ranked.length} of ${sc.routes.length} routes, by net`,
    ...table([
      ["route", "size", "gross", "fees", "slippage", "gas", "rebalance", "net", "net %"],
      ...ranked.map((r: RouteResult) => [r.route + (r.ok ? "" : ` (${r.note})`), `$${r.sizeUsd}`, pct(r.grossPct), usd(r.feesUsd), usd(r.slippageUsd), usd(r.gasUsd), usd(r.rebalanceUsd), usd(r.netUsd), pct(r.netPct)]),
    ], [1, 2, 3, 4, 5, 6, 7, 8]),
    "",
    `DECISION  ${sc.decision.action}${sc.decision.action === "ACT" ? " (simulated, nothing sent)" : ""}: ${sc.decision.reason}`,
  );
  const legs = sc.decision.action === "ACT" ? sc.decision.best?.legs : undefined;
  if (legs) {
    out.push("  prepared:");
    for (const [side, leg] of Object.entries(legs)) out.push(`    ${side}: ${JSON.stringify(leg.prepared)}`);
  }
  return out.join("\n");
}

function logScan(home: string, sc: Scan): string {
  mkdirSync(home, { recursive: true });
  const f = join(home, "scans.jsonl");
  const routes = sc.routes.map(({ legs: _legs, ...r }) => r);
  const best = sc.decision.best ? { ...sc.decision.best, legs: undefined, prepared: sc.decision.action === "ACT" ? { buy: sc.decision.best.legs?.buy.prepared, sell: sc.decision.best.legs?.sell.prepared } : undefined } : undefined;
  appendFileSync(f, `${JSON.stringify({ ...sc, routes, decision: { ...sc.decision, best } })}\n`);
  return f;
}

/** One line per scan for watch: when, the decision, the best route and its numbers. */
export function oneLine(sc: Scan): string {
  const b = sc.decision.best;
  const what = b ? `${b.route} at $${b.sizeUsd}: gross ${pct(b.grossPct)}, costs ${usd(b.feesUsd + b.slippageUsd + b.gasUsd + b.rebalanceUsd)}, net ${usd(b.netUsd)} (${pct(b.netPct)})` : sc.decision.reason;
  return `${utc(sc.at)}  block ${sc.block.toLocaleString("en-US")}  ${sc.decision.action}  ${what}`;
}

async function once(s: Settings, f: ReturnType<typeof flags>["f"], home: string, compact = false) {
  const settings = f.size ? { ...s, sizes_usd: [f.size] } : s;
  const sc = await scan(client(), settings);
  logScan(home, sc);
  if (f.json) console.log(JSON.stringify({ ...sc, routes: sc.routes.map(({ legs: _l, ...r }) => r) }, null, 2));
  else if (compact && sc.decision.action === "SKIP") console.log(oneLine(sc));
  else console.log(render(sc, f.top)); // the whole scan for scan, watch --full, and any ACT
  return sc;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const { pos, f } = flags(rest);
    const home = homeDir();
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
        console.log(HELP);
        return 0;
      case "scan":
        await once(load(home), f, home);
        return 0;
      case "watch": {
        // One line per SKIP (the whole scan with --full, and always for an ACT), then a short summary.
        let acts = 0;
        let done = 0;
        for (let i = 0; i < f.count; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, f.every * 1000));
          const sc = await once(load(home), f, home, !f.full).catch((e) => console.error(`scan failed: ${(e as Error).message.split("\n")[0]}`));
          if (sc) {
            done++;
            if (sc.decision.action === "ACT") acts++;
          }
        }
        if (Number.isFinite(f.count)) console.log(`\n${done} scan(s), ${acts} ACT, ${done - acts} SKIP. Every scan is in ${displayPath(join(home, "scans.jsonl"))}.`);
        return 0;
      }
      case "config": {
        if (pos[0] !== "set") return console.log(JSON.stringify(load(home), null, 2)), 0;
        let s: Settings;
        try {
          s = apply(load(home), pos.slice(1));
        } catch (e) {
          throw new Exit(2, (e as Error).message);
        }
        console.log(`saved to ${displayPath(save(s, home))}\n${JSON.stringify(s, null, 2)}`);
        return 0;
      }
      case "log": {
        const file = join(home, "scans.jsonl");
        if (!existsSync(file)) return console.log("No scans yet."), 0;
        const lines = readFileSync(file, "utf8").trim().split("\n").slice(-f.last);
        for (const l of lines) {
          const sc = JSON.parse(l) as Scan;
          console.log(`${utc(sc.at)}  block ${sc.block}  ${sc.decision.action}  ${sc.decision.reason}`);
        }
        return 0;
      }
      default:
        throw new Exit(2, `Unknown command "${cmd}". Run prosarb --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      console.error(e.message);
      return e.code;
    }
    console.error(`prosarb: ${String((e as Error).message).split("\n")[0]}`);
    return 1;
  }
}

const isMain = process.argv[1] && /(cli\.js|prosarb(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
