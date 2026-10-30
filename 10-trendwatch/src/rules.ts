// The trend rules. Pure functions over the stored history: the same observations always give the same marks
// and the same signals, so a restart (or a replay) can't change what was decided.
import type { Candle, Observation } from "./sources.js";

export interface Rule {
  type: "consecutive" | "ema";
  direction: "down" | "up";
  n: number; // observations in a row it takes; at least 3
  min_move_pct: number; // consecutive: the streak must have moved at least this much in total (0 = any)
  timeframes: string[]; // ema: the candle timeframes that must all agree (empty = the observations themselves)
  spike_atr: number; // a single move bigger than this many ATRs needs the next observation to confirm it
}

export const DEFAULT_RULE: Rule = { type: "consecutive", direction: "down", n: 3, min_move_pct: 0, timeframes: [], spike_atr: 2.5 };
export const EMA_PERIOD = 30;
export const ATR_PERIOD = 30;

export function checkRule(r: Rule): string[] {
  const bad: string[] = [];
  if (!["consecutive", "ema"].includes(r.type)) bad.push("rule must be consecutive or ema");
  if (!["down", "up"].includes(r.direction)) bad.push("direction must be down or up");
  if (!Number.isInteger(r.n) || r.n < 3) bad.push("n must be a whole number, 3 or more: one reading is noise, a trend takes at least three");
  if (!(r.min_move_pct >= 0)) bad.push("min_move_pct must be 0 or more");
  if (!(r.spike_atr > 0)) bad.push("spike_atr must be above 0");
  return bad;
}

/** EMA with an SMA seed: the first `period` closes averaged, then close*k + ema*(1-k), k = 2/(period+1). */
export function ema(closes: number[], period = EMA_PERIOD): (number | undefined)[] {
  const out: (number | undefined)[] = new Array(closes.length).fill(undefined);
  if (closes.length < period) return out;
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = e;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) out[i] = e = closes[i] * k + e * (1 - k);
  return out;
}

/** ATR as the plain average true range of the last `period` bars; without high/low, the average absolute change. */
export function atr(obs: { close: number; high?: number; low?: number }[], period = ATR_PERIOD): (number | undefined)[] {
  const tr = obs.map((o, i) => {
    if (i === 0) return undefined;
    const pc = obs[i - 1].close;
    if (o.high === undefined || o.low === undefined) return Math.abs(o.close - pc);
    return Math.max(o.high - o.low, Math.abs(o.high - pc), Math.abs(o.low - pc));
  });
  return tr.map((_, i) => {
    if (i < period) return undefined;
    const w = tr.slice(i - period + 1, i + 1) as number[];
    return w.reduce((a, b) => a + b, 0) / period;
  });
}

export type Mark =
  | "warming up" // not enough history for the indicators yet
  | "counts" // a move (or an EMA check) in the rule's direction: the streak grows
  | "against" // the other way: the streak starts over
  | "spike?" // a move bigger than spike_atr x ATR: held until the next observation says if it was real
  | "spike ignored" // the next observation took it back: it counted for nothing
  | "spike confirmed";

export interface Row {
  obs: Observation;
  changePct?: number;
  atr?: number;
  mark: Mark;
  streak: number;
  detail?: string; // ema: each timeframe's verdict
  trigger?: boolean;
}

/** For each timeframe, the last candle that had closed by time t, with its EMA and the EMA one candle before. */
function emaAt(series: { c: Candle[]; e: (number | undefined)[] }, t: number, barMs: number) {
  let lo = 0;
  let hi = series.c.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (series.c[mid].t + barMs <= t) (idx = mid), (lo = mid + 1);
    else hi = mid - 1;
  }
  if (idx < 1 || series.e[idx] === undefined || series.e[idx - 1] === undefined) return undefined;
  return { close: series.c[idx].close, now: series.e[idx]!, before: series.e[idx - 1]! };
}

export interface EmaInput {
  bars: Record<string, Candle[]>; // timeframe -> closed candles, oldest first
  barMs: Record<string, number>;
}

/**
 * Walks the history once, oldest first. A trend is confirmed when n observations in a row count for it (and,
 * for consecutive, the streak moved at least min_move_pct). It fires once; after that the streak has to break
 * before it can fire again. A spike can't complete a streak on its own: it waits for the next observation.
 */
export function evaluate(obs: Observation[], rule: Rule, emaIn?: EmaInput): Row[] {
  const rows: Row[] = [];
  const a = atr(obs);
  const sign = rule.direction === "down" ? -1 : 1;
  const tfs = rule.type === "ema" ? (rule.timeframes.length ? rule.timeframes : ["obs"]) : [];
  const series: Record<string, { c: Candle[]; e: (number | undefined)[] }> = {};
  for (const tf of tfs) {
    const c = tf === "obs" ? obs.map((o) => ({ t: o.t, open: o.close, high: o.close, low: o.close, close: o.close })) : emaIn?.bars[tf] ?? [];
    series[tf] = { c, e: ema(c.map((x) => x.close)) };
  }
  let streak = 0;
  let streakStart = 0; // the close before the first counted move
  let fired = false;
  // A held spike remembers the streak from before it, so ignoring it puts things back as if it never happened.
  let pending: { i: number; move: number; streak: number; start: number; fired: boolean } | null = null;

  for (let i = 0; i < obs.length; i++) {
    const o = obs[i];
    const prev = obs[i - 1];
    const row: Row = { obs: o, mark: "warming up", streak };
    rows.push(row);
    if (!prev) continue;
    const move = o.close - prev.close;
    row.changePct = (move / prev.close) * 100;
    row.atr = a[i - 1];

    // Settle a held spike first: did this observation give back more than half of it?
    if (pending) {
      const sp = rows[pending.i];
      if (Math.sign(move) !== Math.sign(pending.move) && Math.abs(move) > Math.abs(pending.move) / 2) {
        sp.mark = "spike ignored";
        sp.streak = pending.streak; // shown as it stood before the spike: the spike never counted
        streak = pending.streak;
        streakStart = pending.start;
        fired = pending.fired;
      } else {
        sp.mark = "spike confirmed";
      }
      pending = null;
    }

    // Does this observation count for the trend?
    let counts: boolean | undefined;
    if (rule.type === "consecutive") {
      counts = Math.sign(move) === sign && move !== 0;
    } else {
      const verdicts: string[] = [];
      let all = true;
      for (const tf of tfs) {
        const v = emaAt(series[tf], o.t, tf === "obs" ? 0 : emaIn!.barMs[tf]);
        if (!v) {
          all = false;
          verdicts.push(`${tf}: no EMA yet`);
          counts = undefined;
          continue;
        }
        const ok = rule.direction === "down" ? v.close < v.now && v.now < v.before : v.close > v.now && v.now > v.before;
        verdicts.push(`${tf} ${ok ? "yes" : "no"} (close ${fmt(v.close)} ${v.close < v.now ? "<" : ">"} EMA ${fmt(v.now)}, EMA ${v.now < v.before ? "falling" : "rising"})`);
        all &&= ok;
      }
      row.detail = verdicts.join("; ");
      counts = verdicts.some((x) => x.includes("no EMA yet")) ? undefined : all;
    }
    if (counts === undefined) {
      row.mark = "warming up";
      streak = 0;
      row.streak = 0;
      continue;
    }

    const isSpike = row.atr !== undefined && Math.abs(move) > rule.spike_atr * row.atr;
    if (isSpike) pending = { i, move, streak, start: streakStart, fired };
    if (counts) {
      if (streak === 0) streakStart = prev.close;
      streak++;
      row.mark = "counts";
    } else {
      streak = 0;
      fired = false;
      row.mark = "against";
    }
    if (isSpike) row.mark = "spike?";
    row.streak = streak;

    const total = streak ? ((o.close - streakStart) / streakStart) * 100 : 0;
    const bigEnough = rule.type !== "consecutive" || Math.abs(total) >= rule.min_move_pct;
    if (counts && !pending && !fired && streak >= rule.n && bigEnough) {
      row.trigger = true;
      fired = true;
    }
  }
  return rows;
}

export const fmt = (x: number) => (Math.abs(x) >= 1000 ? x.toFixed(2) : Math.abs(x) >= 1 ? x.toFixed(4) : x.toPrecision(5));
