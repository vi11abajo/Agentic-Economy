// Notable events of a period. Every candidate gets a score on one scale; the report shows the best 3, at most one
// per kind except graduations. The same rules are printed in the HTML report ("How events were picked").
import { num, pct, short, unit } from "./format.js";
import type { Market, Trade } from "./prosper.js";
import type { DigestEvent, TokenStat } from "./types.js";

export const EVENT_RULES = [
  "A market graduating to FaroSwap: score 100.",
  "The largest single trade, if at least 5x the median trade: 10 x that ratio, at most 90.",
  "The largest price move of a token with at least 10 trades and 1% of the period's volume: half the % move, at most 80.",
  "A new market with at least 5% of the period's volume: 50 x its share.",
  "The largest net buyer, if at least 5% of the period's volume: 50 x that share.",
];

export interface EventInput {
  trades: Trade[];
  tokens: TokenStat[];
  created: Market[];
  graduated: Array<{ market: string; symbol: string }>;
  days: number;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export function pickEvents(i: EventInput): { candidates: DigestEvent[]; top: DigestEvent[] } {
  const c: DigestEvent[] = [];
  const volume = i.trades.reduce((a, t) => a + t.pros, 0);
  for (const g of i.graduated) c.push({ kind: "graduation", score: 100, title: `$${g.symbol} graduated to FaroSwap`, market: g.market });

  if (i.trades.length) {
    const big = i.trades.reduce((a, t) => (t.pros > a.pros ? t : a));
    const ratio = big.pros / median(i.trades.map((t) => t.pros));
    if (ratio >= 5) c.push({ kind: "big_trade", score: Math.min(90, 10 * ratio), title: `${short(big.trader)} ${big.side === "BUY" ? "bought" : "sold"} ${num(big.pros)} PROS of $${big.symbol}`, tx: big.tx, market: big.market });
  }

  const movers = i.tokens.filter((t) => t.changePct !== null && t.trades >= 10 && volume > 0 && t.volume / volume >= 0.01);
  if (movers.length) {
    const m = movers.reduce((a, t) => (Math.abs(t.changePct!) > Math.abs(a.changePct!) ? t : a));
    c.push({ kind: "mover", score: Math.min(80, Math.abs(m.changePct!) / 2), title: `$${m.symbol} price ${pct(m.changePct)} over the ${unit(i.days)}`, market: m.market });
  }

  const fresh = i.created.map((m) => ({ m, v: i.tokens.find((t) => t.market === m.market)?.volume ?? 0 })).filter((x) => volume > 0 && x.v / volume >= 0.05);
  if (fresh.length) {
    const f = fresh.reduce((a, x) => (x.v > a.v ? x : a));
    c.push({ kind: "new_market", score: 50 * (f.v / volume), title: `New market $${f.m.symbol} took ${Math.round((100 * f.v) / volume)}% of the volume`, market: f.m.market });
  }

  const net = new Map<string, number>();
  for (const t of i.trades) net.set(t.trader, (net.get(t.trader) ?? 0) + (t.side === "BUY" ? t.pros : -t.pros));
  const [who, amount] = [...net.entries()].reduce((a, e) => (e[1] > a[1] ? e : a), ["", 0] as [string, number]);
  if (who && volume > 0 && amount / volume >= 0.05) c.push({ kind: "net_buyer", score: 50 * (amount / volume), title: `${short(who)} net bought ${num(amount)} PROS` });

  const sorted = [...c].sort((a, b) => b.score - a.score);
  const top: DigestEvent[] = [];
  for (const e of sorted) {
    if (top.length === 3) break;
    if (e.kind !== "graduation" && top.some((x) => x.kind === e.kind)) continue;
    top.push(e);
  }
  return { candidates: sorted, top };
}
