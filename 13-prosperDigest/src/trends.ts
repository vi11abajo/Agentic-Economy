// Patterns across digests in history.jsonl: growth/decline streaks and the gap to the recent average.
import { ordinal, unit } from "./format.js";
import type { Digest, Metrics } from "./types.js";

const WATCH: Array<[keyof Metrics, string]> = [["volume", "Volume"], ["trades", "Trades"], ["traders", "Traders"], ["netFlow", "Net flow"]];

/** `history` is the earlier digests, oldest first; only those with the same period length count. */
export function trends(history: Digest[], cur: Metrics, days = 7): string[] {
  const same = history.filter((d) => (d.days ?? 7) === days).map((d) => d.metrics);
  if (same.length < 3) return [];
  const u = unit(days);
  const out: string[] = [];
  for (const [k, name] of WATCH) {
    const series = [...same.map((m) => m[k]), cur[k]];
    let up = 0, down = 0;
    for (let i = series.length - 1; i > 0 && series[i] > series[i - 1]; i--) up++;
    for (let i = series.length - 1; i > 0 && series[i] < series[i - 1]; i--) down++;
    if (up >= 3) out.push(`${name} up for the ${ordinal(up)} ${u} in a row`);
    if (down >= 3) out.push(`${name} down for the ${ordinal(down)} ${u} in a row`);
    const last = same.slice(-4).map((m) => m[k]);
    const avg = last.reduce((a, b) => a + b, 0) / last.length;
    if (avg !== 0) {
      const diff = ((cur[k] - avg) / Math.abs(avg)) * 100;
      if (Math.abs(diff) >= 20) out.push(`${name} ${Math.round(Math.abs(diff))}% ${diff > 0 ? "above" : "below"} the ${last.length}-${u} average`);
    }
  }
  return out;
}
