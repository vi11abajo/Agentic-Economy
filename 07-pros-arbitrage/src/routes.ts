// The arithmetic of one scan. A route buys PROS on one venue and sells the same PROS on another. Each venue
// prices a leg for a given size (buy for N dollars, sell N PROS) with its fee, slippage and gas inside; this file
// turns two legs into a cost breakdown and the scan into a decision. Pure functions, unit-tested.
import type { Settings } from "./config.js";

export interface Leg {
  pros: number; // PROS bought (after fees) or sold
  usd: number; // dollars spent (buy) or received after fees (sell)
  feeUsd: number;
  gasUsd: number;
  complete: boolean; // false when the book or pool can't fill the size
  /** The transaction or order this leg would send. Nothing is ever sent: it is simulated or only prepared. */
  prepared: Record<string, unknown>;
}

export interface Venue {
  id: string; // "faroswap-0.01%", "okx", ...
  kind: "dex" | "cex";
  /** Best price before fees, in USD per PROS: what you pay buying / get selling at the top of the book. */
  askUsd: number;
  bidUsd: number;
  /** PROS it costs to move PROS bought here to the other venue (withdrawal), 0 for the wallet. */
  withdrawPros: number;
  /** PROS it costs to deposit PROS here, 0 for the wallet. */
  depositPros: number;
  buy(usd: number): Promise<Leg>;
  sell(pros: number): Promise<Leg>;
}

export interface RouteResult {
  route: string; // "buy okx → sell faroswap-0.01%"
  buyAt: string;
  sellAt: string;
  sizeUsd: number;
  grossPct: number;
  grossUsd: number;
  feesUsd: number;
  slippageUsd: number;
  gasUsd: number;
  rebalanceUsd: number;
  netUsd: number;
  netPct: number;
  ok: boolean;
  note?: string;
  legs?: { buy: Leg; sell: Leg };
}

/**
 * net = what the sale brings - what the buy cost - gas - rebalance. The costs add up to the gap between the
 * gross spread (top of book, before fees) and that net: fees and gas are counted directly, rebalance is the
 * PROS withdrawal (and deposit) that moves the bought PROS to the selling venue, and slippage is what remains (book depth and pool price impact for this size).
 */
export function costRoute(buyAt: Venue, sellAt: Venue, sizeUsd: number, buy: Leg, sell: Leg, prosUsd: number, s: Settings): RouteResult {
  const route = `buy ${buyAt.id} → sell ${sellAt.id}`;
  const grossPct = ((sellAt.bidUsd - buyAt.askUsd) / buyAt.askUsd) * 100;
  const grossUsd = (sizeUsd * grossPct) / 100;
  const feesUsd = buy.feeUsd + sell.feeUsd;
  const gasUsd = buy.gasUsd + sell.gasUsd;
  const rebalanceUsd = s.rebalance ? (buyAt.withdrawPros + sellAt.depositPros) * prosUsd : 0;
  const netUsd = sell.usd - buy.usd - gasUsd - rebalanceUsd;
  const slippageUsd = grossUsd - feesUsd - gasUsd - rebalanceUsd - netUsd;
  const base = { route, buyAt: buyAt.id, sellAt: sellAt.id, sizeUsd, grossPct, grossUsd, feesUsd, slippageUsd, gasUsd, rebalanceUsd, netUsd, netPct: (netUsd / sizeUsd) * 100, legs: { buy, sell } };
  if (!buy.complete || !sell.complete) return { ...base, ok: false, note: `${!buy.complete ? buyAt.id : sellAt.id} can't fill $${sizeUsd}` };
  return { ...base, ok: true };
}

export interface Decision {
  action: "ACT" | "SKIP";
  reason: string;
  best?: RouteResult;
}

const money = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(Math.abs(x) < 10 ? 3 : 2)}`;
export const pct = (x: number, d = 3) => `${x >= 0 ? "+" : ""}${x.toFixed(d)}%`;

/** ACT only when the best fillable route clears both thresholds; otherwise SKIP and say why. */
export function decide(routes: RouteResult[], s: Settings): Decision {
  const ok = routes.filter((r) => r.ok);
  if (ok.length === 0) return { action: "SKIP", reason: routes.length ? "no route can be filled at these sizes" : "no prices to compare" };
  const best = ok.reduce((a, b) => (b.netUsd > a.netUsd ? b : a));
  const costs = `fees ${money(best.feesUsd)}, slippage ${money(best.slippageUsd)}, gas ${money(best.gasUsd)}, rebalance ${money(best.rebalanceUsd)}`;
  const line = `best: ${best.route} at $${best.sizeUsd}: gross ${pct(best.grossPct)} (${money(best.grossUsd)}), ${costs}, net ${money(best.netUsd)} (${pct(best.netPct)})`;
  if (best.netUsd >= s.min_net_usd && best.netPct >= s.min_net_pct) return { action: "ACT", reason: line, best };
  const miss = [best.netUsd < s.min_net_usd ? `net ${money(best.netUsd)} < ${money(s.min_net_usd)}` : "", best.netPct < s.min_net_pct ? `${pct(best.netPct)} < ${pct(s.min_net_pct)}` : ""].filter(Boolean).join(" and ");
  return { action: "SKIP", reason: `${line}. Below the threshold: ${miss}`, best };
}
