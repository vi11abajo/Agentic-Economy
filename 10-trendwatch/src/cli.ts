#!/usr/bin/env node
// trendwatch: watches a price over time and signals only when a trend holds for several observations in a row,
// never on one reading. Every observation is kept on disk, so a run picks up where the last one stopped.
// Exit codes: 0 done, 1 error, 2 bad input, 3 locked by another run.
import { spawnSync } from "node:child_process";
import { checkRule, DEFAULT_RULE, evaluate, fmt, type Row, type Rule } from "./rules.js";
import { BAR_MS, mcpReader, okxSource, padKey, poolSource, type Candle, type Observation, type Source } from "./sources.js";
import { displayPath, homeDir, KeyedLog, listWatches, loadWatch, lock, removeWatch, saveWatch, type Watch } from "./store.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const HELP = `trendwatch: watch a price and signal only when a trend holds over several observations.

  trendwatch add <name> <source> [options]   start watching; the history since --since is loaded at once
  trendwatch observe [name ...]              one pass: new observations for every watch (or the named ones)
  trendwatch watch [--every SEC]             observe again and again (default every 60 s)
  trendwatch history <name> [--last N|--all] stored observations, how each one counted, and the signals
  trendwatch signals [name]                  every signal, with the exact observation that confirmed it
  trendwatch set <name> k=v [...]            change the rule (n, direction, type, min_move_pct, timeframes,
                                             spike_atr) or on_trigger; the stored history is re-read with it
  trendwatch list | remove <name>

  <source>:  okx:<instId>             e.g. okx:PROS-USDT, okx:BTC-USDT, okx:ETH-USDT-SWAP (public data, no key)
             pharos-pool:<address>    a V3 pool on Pharos, with --base <token address> and --every-blocks N
  options:   --bar 15m (okx: one observation per candle; 1m 5m 15m 30m 1H 4H 1D)   --since 2026-10-28
             --rule consecutive|ema   --direction down|up   --n 3   --min-move 1.0 (%, consecutive)
             --timeframes 1H,4H (ema)   --spike-atr 2.5   --on-trigger "<command>"

Data lives in ${displayPath(homeDir())}/watches/<name>: watch.json, observations.jsonl, signals.jsonl.`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--all") f.all = "1";
    else if (a.startsWith("--")) {
      if (argv[i + 1] === undefined) throw new Exit(2, `${a} needs a value`);
      f[a.slice(2)] = argv[++i];
    } else pos.push(a);
  }
  return { pos, f };
}

export interface Deps {
  home: string;
  source: (w: Watch) => Source;
  out: (s: string) => void;
  now: () => number;
  run: (cmd: string, env: Record<string, string>) => number;
}

function defaultSource(w: Watch): Source {
  const [kind, id] = [w.source.slice(0, w.source.indexOf(":")), w.source.slice(w.source.indexOf(":") + 1)];
  if (kind === "okx") return okxSource(id, w.bar);
  if (kind === "pharos-pool") return poolSource(id, w.base ?? "", w.every_blocks ?? 900, mcpReader);
  throw new Exit(2, `unknown source ${w.source}: use okx:<instId> or pharos-pool:<address>`);
}

const utc = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
const pct = (x?: number) => (x === undefined ? "" : `${x >= 0 ? "+" : ""}${x.toFixed(2)}%`);

function describe(r: Rule): string {
  const what = r.type === "consecutive" ? `${r.direction === "down" ? "lower" : "higher"} close ${r.n} observations in a row${r.min_move_pct ? `, at least ${r.min_move_pct}% in total` : ""}` : `close ${r.direction === "down" ? "below a falling" : "above a rising"} EMA30 on ${r.timeframes.length ? r.timeframes.join(" + ") : "the observations"}, ${r.n} observations in a row`;
  return `${what}; a move over ${r.spike_atr} ATR waits for the next observation`;
}

/** How far back the EMA filter needs candles: 2 x the period before the first observation. */
const emaLead = (tf: string) => 2 * 30 * (BAR_MS[tf] ?? 0);

async function load(d: Deps, w: Watch, fetchNew: boolean) {
  const obsLog = new KeyedLog<Observation>(d.home, w.name, "observations.jsonl");
  const sigLog = new KeyedLog<Record<string, unknown> & { key: string }>(d.home, w.name, "signals.jsonl");
  const sinceMs = Date.parse(w.since);
  let added = 0;
  const bars: Record<string, Candle[]> = {};
  const src = fetchNew ? d.source(w) : null;
  try {
    if (src) added = obsLog.add(await src.fetch(obsLog.last()?.key, sinceMs));
    if (w.rule.type === "ema") {
      for (const tf of w.rule.timeframes) {
        const log = new KeyedLog<Candle & { key: string }>(d.home, w.name, `bars-${tf}.jsonl`);
        if (src?.candles) {
          const last = log.last();
          log.add((await src.candles(tf, last ? last.t + 1 : sinceMs - emaLead(tf))).map((c) => ({ ...c, key: padKey(c.t) })));
        }
        bars[tf] = log.all();
      }
    }
  } finally {
    await src?.close?.();
  }
  const rows = evaluate(obsLog.all(), w.rule, { bars, barMs: BAR_MS });
  return { obsLog, sigLog, rows, added, repaired: obsLog.repaired };
}

function signalOf(w: Watch, r: Row) {
  return { key: r.obs.key, at: new Date(r.obs.t).toISOString(), close: r.obs.close, block: r.obs.block, streak: r.streak, rule: describe(w.rule), detail: r.detail, recorded: new Date().toISOString() };
}

async function observe(d: Deps, w: Watch): Promise<string[]> {
  const { sigLog, rows, added, repaired } = await load(d, w, true);
  const out: string[] = [];
  const last = rows[rows.length - 1];
  if (repaired) out.push(`  ${w.name}: dropped a half-written line left by an interrupted run`);
  out.push(last ? `${w.name.padEnd(14)} +${added} new, ${rows.length} stored · last ${utc(last.obs.t)} close ${fmt(last.obs.close)} ${pct(last.changePct)} · ${last.mark}${last.mark === "warming up" ? "" : `, streak ${last.streak}/${w.rule.n}`}` : `${w.name.padEnd(14)} no observations yet`);
  // New signals: confirmed now or (after a restart) while the watch was down; each one is recorded exactly once.
  const fresh = rows.filter((r) => r.trigger && !sigLog.has(r.obs.key)).map((r) => signalOf(w, r));
  sigLog.add(fresh);
  // A signal is live when it was confirmed by the newest observations; older ones were found in the history that
  // was just loaded (a new watch, or a restart after a long stop). Those are recorded, but on_trigger is for live ones.
  const step = w.source.startsWith("okx:") ? BAR_MS[w.bar] : (w.every_blocks ?? 900) * 1000;
  const isLive = (s: { at: string }) => Date.parse(s.at) >= d.now() - 2 * step;
  const old = fresh.filter((s) => !isLive(s));
  if (old.length) {
    // Loading a long history can turn up dozens; the latest three say enough, history lists them all.
    out.push(`  ${old.length} signal(s) found in the loaded history${old.length > 3 ? ", the latest:" : ":"}`);
    for (const s of old.slice(-3)) out.push(`    trend confirmed at ${utc(Date.parse(s.at))}, close ${fmt(s.close)}, ${s.streak} in a row`);
  }
  for (const s of fresh.filter(isLive)) {
    out.push(`  SIGNAL ${w.name}: trend confirmed at ${utc(Date.parse(s.at))}, close ${fmt(s.close)}, ${s.streak} in a row`);
    if (w.on_trigger) {
      const code = d.run(w.on_trigger, { TRENDWATCH_WATCH: w.name, TRENDWATCH_SOURCE: w.source, TRENDWATCH_AT: s.at, TRENDWATCH_CLOSE: String(s.close), TRENDWATCH_KEY: s.key });
      out.push(`  on_trigger ran, exit ${code}`);
    }
  }
  return out;
}

function historyLines(w: Watch, rows: Row[], sigs: { key: string; at: string; close: number; recorded: string }[], last: number): string[] {
  const shown = rows.slice(-last);
  const out = [`${w.name} · ${w.source}${w.source.startsWith("okx:") ? ` ${w.bar}` : ""} · rule: ${describe(w.rule)}`, `stored: ${rows.length} observations since ${utc(rows[0]?.obs.t ?? Date.parse(w.since))}${shown.length < rows.length ? `, last ${shown.length} shown` : ""}`, ""];
  out.push(`  ${"time".padEnd(20)} ${"close".padStart(10)} ${"change".padStart(8)}  ${"streak".padStart(6)}  mark`);
  for (const r of shown) {
    const tag = r.trigger ? "  <== TREND CONFIRMED" : "";
    out.push(`  ${utc(r.obs.t).padEnd(20)} ${fmt(r.obs.close).padStart(10)} ${pct(r.changePct).padStart(8)}  ${(r.mark === "warming up" ? "" : `${r.streak}/${w.rule.n}`).padStart(6)}  ${r.mark}${tag}`);
    if (r.detail && (r.trigger || r.mark.startsWith("spike"))) out.push(`  ${"".padEnd(20)} ${r.detail}`);
  }
  out.push("", sigs.length ? "signals:" : "signals: none yet");
  for (const s of sigs) out.push(`  ${utc(Date.parse(s.at))}  close ${fmt(s.close)}  (observation ${s.key.replace(/^0+/, "")}, recorded ${utc(Date.parse(s.recorded))})`);
  return out;
}

function ruleFrom(f: Record<string, string>, base: Rule = DEFAULT_RULE): Rule {
  return {
    type: (f.rule as Rule["type"]) ?? base.type,
    direction: (f.direction as Rule["direction"]) ?? base.direction,
    n: f.n !== undefined ? Number(f.n) : base.n,
    min_move_pct: f["min-move"] !== undefined ? Number(f["min-move"]) : base.min_move_pct,
    timeframes: f.timeframes !== undefined ? f.timeframes.split(",").map((x) => x.trim()).filter(Boolean) : base.timeframes,
    spike_atr: f["spike-atr"] !== undefined ? Number(f["spike-atr"]) : base.spike_atr,
  };
}

function need(home: string, name: string | undefined): Watch {
  if (!name) throw new Exit(2, "Which watch? trendwatch list shows them.");
  const w = loadWatch(home, name);
  if (!w) throw new Exit(2, `No watch "${name}". trendwatch list shows them.`);
  return w;
}

export async function main(argv: string[], deps?: Partial<Deps>): Promise<number> {
  const d: Deps = {
    home: deps?.home ?? homeDir(),
    source: deps?.source ?? defaultSource,
    out: deps?.out ?? ((s) => console.log(s)),
    now: deps?.now ?? (() => Date.now()),
    run: deps?.run ?? ((cmd, env) => spawnSync(cmd, { shell: true, stdio: "inherit", env: { ...process.env, ...env } }).status ?? 1),
  };
  const [cmd, ...rest] = argv;
  let unlock: (() => void) | undefined;
  try {
    const { pos, f } = parse(rest);
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
        d.out(HELP);
        return 0;

      case "add": {
        const [name, source] = pos;
        if (!name || !/^[\w.-]+$/.test(name)) throw new Exit(2, "add <name> <source>: the name is letters, digits, - _ .");
        if (!source || !/^(okx|pharos-pool):.+/.test(source)) throw new Exit(2, "the source is okx:<instId> or pharos-pool:<address>");
        if (loadWatch(d.home, name)) throw new Exit(2, `"${name}" already exists; change it with trendwatch set, or remove it first`);
        const rule = ruleFrom(f);
        const bad = checkRule(rule);
        if (rule.type === "ema") for (const tf of rule.timeframes) if (!BAR_MS[tf]) bad.push(`unknown timeframe ${tf}`);
        const bar = f.bar ?? "15m";
        if (source.startsWith("okx:") && !BAR_MS[bar]) bad.push(`unknown bar ${bar}`);
        const since = f.since ? Date.parse(f.since) : d.now() - 3 * 86_400_000;
        if (!Number.isFinite(since)) bad.push("--since must be a date, e.g. 2026-10-28");
        if (bad.length) throw new Exit(2, bad.join("\n"));
        const w: Watch = { name, source, bar, base: f.base, every_blocks: f["every-blocks"] ? Number(f["every-blocks"]) : undefined, since: new Date(since).toISOString(), rule, on_trigger: f["on-trigger"], created: new Date(d.now()).toISOString() };
        if (source.startsWith("pharos-pool:")) w.every_blocks ??= 900;
        unlock = lock(d.home);
        d.source(w); // fails here on a bad pool or base address, before anything is saved
        saveWatch(d.home, w);
        d.out(`watching ${name}: ${source} · ${describe(rule)}\nloading the history since ${utc(since)}...`);
        for (const l of await observe(d, w)) d.out(l);
        return 0;
      }

      case "observe": {
        const names = pos.length ? pos : listWatches(d.home);
        if (!names.length) return d.out("Nothing watched yet: trendwatch add <name> <source>"), 0;
        unlock = lock(d.home);
        for (const n of names) {
          try {
            for (const l of await observe(d, need(d.home, n))) d.out(l);
          } catch (e) {
            if (e instanceof Exit) throw e;
            d.out(`${n.padEnd(14)} failed this pass, nothing stored for it: ${(e as Error).message.split("\n")[0]}`);
          }
        }
        return 0;
      }

      case "watch": {
        const every = Number(f.every ?? 60);
        const count = f.count ? Number(f.count) : Infinity;
        if (!(every > 0)) throw new Exit(2, "--every needs seconds");
        for (let i = 0; i < count; i++) {
          if (i > 0) await new Promise((r) => setTimeout(r, every * 1000));
          d.out(`-- ${utc(d.now())}`);
          const code = await main(["observe", ...pos], deps);
          if (code !== 0 && code !== 3) return code;
        }
        return 0;
      }

      case "history": {
        const w = need(d.home, pos[0]);
        const { rows, sigLog } = await load(d, w, false);
        const last = f.all ? rows.length : Number(f.last ?? 30);
        for (const l of historyLines(w, rows, sigLog.all() as never, last)) d.out(l);
        return 0;
      }

      case "signals": {
        const names = pos.length ? pos : listWatches(d.home);
        let any = false;
        for (const n of names) {
          for (const s of new KeyedLog<{ key: string; at: string; close: number; streak: number; rule: string }>(d.home, n, "signals.jsonl").all()) {
            any = true;
            d.out(`${n.padEnd(14)} ${utc(Date.parse(s.at))}  close ${fmt(s.close)}  ${s.streak} in a row  (${s.rule})`);
          }
        }
        if (!any) d.out("No signals yet.");
        return 0;
      }

      case "set": {
        const w = need(d.home, pos[0]);
        const kv: Record<string, string> = {};
        for (const p of pos.slice(1)) {
          const i = p.indexOf("=");
          if (i < 1) throw new Exit(2, `set takes k=v, got ${p}`);
          kv[p.slice(0, i)] = p.slice(i + 1);
        }
        if ("on_trigger" in kv) w.on_trigger = kv.on_trigger || undefined;
        const map: Record<string, string> = { type: "rule", direction: "direction", n: "n", min_move_pct: "min-move", timeframes: "timeframes", spike_atr: "spike-atr" };
        const unknown = Object.keys(kv).filter((k) => k !== "on_trigger" && !map[k]);
        if (unknown.length) throw new Exit(2, `unknown setting ${unknown.join(", ")}; settings: ${Object.keys(map).join(", ")}, on_trigger`);
        w.rule = ruleFrom(Object.fromEntries(Object.entries(kv).filter(([k]) => map[k]).map(([k, v]) => [map[k], v])), w.rule);
        const bad = checkRule(w.rule);
        if (bad.length) throw new Exit(2, bad.join("\n"));
        unlock = lock(d.home);
        saveWatch(d.home, w);
        d.out(`${w.name}: ${describe(w.rule)}${w.on_trigger ? `; on_trigger: ${w.on_trigger}` : ""}`);
        return 0;
      }

      case "list": {
        const names = listWatches(d.home);
        if (!names.length) return d.out("Nothing watched yet: trendwatch add <name> <source>"), 0;
        for (const n of names) {
          const w = loadWatch(d.home, n)!;
          d.out(`${n.padEnd(14)} ${w.source}${w.source.startsWith("okx:") ? ` ${w.bar}` : ""} · ${describe(w.rule)}`);
        }
        return 0;
      }

      case "remove": {
        need(d.home, pos[0]);
        unlock = lock(d.home);
        removeWatch(d.home, pos[0]);
        d.out(`removed ${pos[0]} and its history`);
        return 0;
      }

      default:
        throw new Exit(2, `Unknown command "${cmd}". Run trendwatch --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      console.error(e.message);
      return e.code;
    }
    const msg = String((e as Error).message).split("\n")[0];
    console.error(`trendwatch: ${msg}`);
    return /another trendwatch run holds/.test(msg) ? 3 : 1;
  } finally {
    unlock?.();
  }
}

const isMain = process.argv[1] && /(cli\.js|trendwatch(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
