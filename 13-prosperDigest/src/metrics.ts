// Key numbers of a period from its trades, the markets created in it, traders' first trade blocks and market
// phases at the period's first and last block.
import { GRADUATED, ON_CURVE, type Market, type Trade } from "./prosper.js";
import type { Metrics, TokenStat } from "./types.js";

export interface MetricsInput {
  trades: Trade[];
  created: Market[];
  traders: Record<string, number>; // lower-case address -> first trade block
  startBlock: number;
  endBlock: number;
  phases: Record<string, { start: number | null; end: number | null }>;
}

export function computeMetrics(i: MetricsInput): { metrics: Metrics; tokens: TokenStat[] } {
  let buys = 0, sells = 0, fees = 0;
  const who = new Set<string>();
  const per = new Map<string, TokenStat>();
  for (const t of [...i.trades].sort((a, b) => a.block - b.block)) {
    if (t.side === "BUY") buys += t.pros;
    else sells += t.pros;
    fees += t.fee;
    who.add(t.trader.toLowerCase());
    const s = per.get(t.market) ?? { market: t.market, symbol: t.symbol, volume: 0, trades: 0, firstPrice: t.price, lastPrice: t.price, changePct: null, phaseEnd: i.phases[t.market]?.end ?? null };
    s.volume += t.pros;
    s.trades++;
    s.lastPrice = t.price;
    per.set(t.market, s);
  }
  for (const s of per.values()) s.changePct = s.trades >= 2 && s.firstPrice > 0 ? ((s.lastPrice - s.firstPrice) / s.firstPrice) * 100 : null;
  const newTraders = [...who].filter((a) => (i.traders[a] ?? -1) >= i.startBlock && i.traders[a] <= i.endBlock).length;
  const phases = Object.values(i.phases);
  return {
    metrics: {
      volume: buys + sells,
      buys,
      sells,
      netFlow: buys - sells,
      trades: i.trades.length,
      traders: who.size,
      newTraders,
      fees,
      newMarkets: i.created.length,
      graduated: phases.filter((p) => p.end === GRADUATED && p.start !== GRADUATED).length,
      onCurve: phases.filter((p) => p.end === ON_CURVE).length,
    },
    tokens: [...per.values()].sort((a, b) => b.volume - a.volume),
  };
}

/** % change; null when there is nothing to compare with. */
export function change(cur: number, prev: number | undefined): number | null {
  if (prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
