// The arithmetic, with no chain in sight, so tests can poke at it directly.
//
// One picture covers both protocols. A position is a list of collateral legs and debt legs, each priced in one
// quote unit (USD for the Aave forks, the loan token for a Morpho market). A collateral leg counts at
// value x liquidation threshold. Health is "what the collateral is allowed to carry / what is owed".
import type { Hex } from "viem";

export interface Leg {
  token: Hex;
  symbol: string;
  decimals: number;
  /** Raw token amount. */
  amount: bigint;
  /** Value of the whole amount in the quote unit. */
  value: number;
  /** Liquidation threshold (Aave) or LLTV (Morpho), 0..1. Zero on debt legs. */
  lt: number;
  /** Annual rate the leg grows at by itself: supply APR on Aave collateral, borrow APR on debt, 0 for Morpho collateral. */
  apr: number;
  /** Borrow APR if the pool's spare cash were all withdrawn (utilisation 100%). Debt legs only. */
  stressApr?: number;
  /**
   * How the oracle price behaved over the last week. "climbing" means every daily sample was at or above the one
   * before: what a vault share priced at its NAV looks like. "moving" is everything else. "flat" never changed.
   */
  priceShape: "climbing" | "flat" | "moving";
  /** Annualised oracle drift over the sample window, continuous compounding. */
  trendApr: number;
}

export interface Snapshot {
  kind: "aave" | "morpho";
  venue: string;
  /** Morpho market id or Aave pool address. */
  where: Hex;
  wallet: Hex;
  block: number;
  time: number;
  quote: string;
  hf: number;
  collateral: Leg[];
  debt: Leg[];
}

export interface Thresholds {
  warn: number;
  critical: number;
  /** Health we suggest getting back to. */
  target: number;
  /** A level only clears once health is this far above the line it crossed, so 1.299/1.301 doesn't spam. */
  rearm: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { warn: 1.3, critical: 1.1, target: 1.5, rearm: 0.02 };

export type Level = "ok" | "warn" | "critical" | "liquidatable";
const RANK: Record<Level, number> = { ok: 0, warn: 1, critical: 2, liquidatable: 3 };

export function checkThresholds(t: Thresholds): string | null {
  if (!(t.critical > 1)) return "--critical has to be above 1.0 (1.0 is where liquidation starts)";
  if (!(t.warn > t.critical)) return "--warn has to be above --critical";
  if (!(t.target > t.warn)) return "--target has to be above --warn, otherwise the advice lands you back in a warning";
  if (!(t.rearm >= 0 && t.rearm < 0.5)) return "--rearm should be a small step like 0.02";
  return null;
}

export function levelOf(hf: number, t: Thresholds): Level {
  if (hf < 1) return "liquidatable";
  if (hf <= t.critical) return "critical";
  if (hf <= t.warn) return "warn";
  return "ok";
}

/** Level with memory: getting worse is instant, getting better needs `rearm` of headroom above the line. */
export function nextLevel(prev: Level | undefined, hf: number, t: Thresholds): Level {
  const raw = levelOf(hf, t);
  if (prev === undefined || RANK[raw] >= RANK[prev]) return raw;
  const line = prev === "liquidatable" ? 1 : prev === "critical" ? t.critical : t.warn;
  return hf > line + t.rearm ? raw : prev;
}

export const worse = (a: Level, b: Level | undefined) => b === undefined ? a !== "ok" : RANK[a] > RANK[b];
export const better = (a: Level, b: Level | undefined) => b !== undefined && RANK[a] < RANK[b];

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const carried = (s: Snapshot) => sum(s.collateral.map((c) => c.value * c.lt));
export const owed = (s: Snapshot) => sum(s.debt.map((d) => d.value));

/**
 * Collateral whose price can actually hurt: it moves, and it isn't the same token as the debt (USDC posted
 * against a USDC loan wobbles with the oracle on both sides at once, so it cancels out).
 */
export function movingCollateral(s: Snapshot): Leg[] {
  const owedTokens = new Set(s.debt.map((d) => d.token.toLowerCase()));
  return s.collateral.filter((c) => c.lt > 0 && c.priceShape === "moving" && !owedTokens.has(c.token.toLowerCase()));
}

/**
 * How far the "moving" collateral can fall before health hits 1, as a fraction. Stable-priced legs (climbing or
 * flat) are held still: dropping a NAV-priced vault share by 5% is not a thing its oracle does. null when nothing
 * moves, which is exactly the case where a price-drop number would mislead.
 */
export function dropToLiquidation(s: Snapshot): number | null {
  const moving = sum(movingCollateral(s).map((c) => c.value * c.lt));
  if (moving <= 0) return null;
  const spare = carried(s) - owed(s);
  if (spare <= 0) return 0;
  return Math.min(1, spare / moving);
}

export interface Clock {
  /** Collateral side growth per year (supply APR + the oracle's drift where it is steady). */
  collateralGrowth: number;
  /** Debt growth per year (weighted borrow APR). */
  debtGrowth: number;
  /** collateralGrowth - debtGrowth. Negative means health is shrinking on its own. */
  net: number;
  /** Days until health reaches 1.0 at these rates, prices otherwise frozen. null if health isn't shrinking. */
  days: number | null;
}

/**
 * The carry clock. A loop against a NAV-priced vault share is never going to be liquidated by a crash of its
 * price; it gets liquidated when what the debt costs outruns what the collateral earns. So: how fast does each
 * side grow, and how long until the gap eats the headroom? With stress=true the debt is charged at the rate the
 * market would pay if every supplier with spare cash left.
 */
export function carryClock(s: Snapshot, stress = false): Clock {
  const cw = sum(s.collateral.map((c) => c.value * c.lt));
  const collateralGrowth = cw > 0 ? sum(s.collateral.map((c) => c.value * c.lt * (c.apr + (c.priceShape === "climbing" ? c.trendApr : 0)))) / cw : 0;
  const dw = owed(s);
  const debtGrowth = dw > 0 ? sum(s.debt.map((d) => d.value * (stress ? d.stressApr ?? d.apr : d.apr))) / dw : 0;
  const net = collateralGrowth - debtGrowth;
  let days: number | null = null;
  if (s.hf <= 1) days = 0;
  else if (net < 0) days = (Math.log(s.hf) / -net) * 365;
  return { collateralGrowth, debtGrowth, net, days };
}

export interface Move {
  kind: "repay" | "add";
  leg: Leg;
  /** Raw token amount. */
  amount: bigint;
  /** Health the plain arithmetic expects after the move. */
  expectedHf: number;
}

const unitsFor = (leg: Leg, value: number): bigint => {
  const whole = Number(leg.amount) / 10 ** leg.decimals;
  const price = whole > 0 ? leg.value / whole : 0;
  if (price <= 0 || value <= 0) return 0n;
  // Round up in base units, plus one more unit so the float maths never leaves us a hair short of the target.
  const raw = Math.ceil((value / price) * 10 ** leg.decimals);
  return BigInt(raw) + 1n;
};

/**
 * The two classic ways out, sized to bring health back to `target`: repay part of the biggest debt, or add more
 * of the collateral that counts the most. Empty when health is already at target. These are the arithmetic's
 * guesses; simulate.ts then runs them against the real contracts and reports the health they actually produce.
 */
export function movesToTarget(s: Snapshot, target: number): Move[] {
  const c = carried(s);
  const d = owed(s);
  if (d <= 0 || c / d >= target) return [];
  const out: Move[] = [];
  const debtLeg = [...s.debt].sort((a, b) => b.value - a.value)[0];
  const repayValue = Math.min(debtLeg.value, d - c / target);
  const repay = unitsFor(debtLeg, repayValue);
  if (repay > 0n) {
    const left = d - repayValue;
    out.push({ kind: "repay", leg: debtLeg, amount: repay > debtLeg.amount ? debtLeg.amount : repay, expectedHf: left > 0 ? c / left : Infinity });
  }
  const collLeg = [...s.collateral].filter((x) => x.lt > 0 && x.amount > 0n).sort((a, b) => b.value * b.lt - a.value * a.lt)[0];
  if (collLeg) {
    const addValue = (target * d - c) / collLeg.lt;
    const add = unitsFor(collLeg, addValue);
    if (add > 0n) out.push({ kind: "add", leg: collLeg, amount: add, expectedHf: (c + addValue * collLeg.lt) / d });
  }
  return out;
}

/** Oracle samples (oldest first) to a shape and an annualised drift. */
export function priceShape(samples: { time: number; price: number }[]): { shape: Leg["priceShape"]; trendApr: number } {
  if (samples.length < 2) return { shape: "moving", trendApr: 0 };
  const first = samples[0];
  const last = samples[samples.length - 1];
  const years = (last.time - first.time) / 31_536_000;
  const trendApr = years > 0 && first.price > 0 && last.price > 0 ? Math.log(last.price / first.price) / years : 0;
  let up = true;
  let still = true;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i].price < samples[i - 1].price) up = false;
    if (samples[i].price !== samples[i - 1].price) still = false;
  }
  return { shape: still ? "flat" : up ? "climbing" : "moving", trendApr };
}
