// Words. Everything a person reads comes out of here, so the numbers are formatted in one place and the console,
// Telegram and Discord all say the same thing.
import type { Advice, Assessment } from "./look.js";
import { movingCollateral, type Clock, type Leg, type Snapshot } from "./health.js";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function amount(raw: bigint, decimals: number, maxFrac = 4): string {
  const n = Number(raw) / 10 ** decimals;
  const frac = n >= 1000 ? 2 : n >= 1 ? Math.min(maxFrac, 4) : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: frac });
}

const money = (v: number, quote: string) => (quote === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${quote}`);
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
export const hfText = (h: number) => (Number.isFinite(h) ? h.toFixed(4) : "no debt");

const legs = (xs: Leg[]) => xs.map((l) => `${amount(l.amount, l.decimals)} ${l.symbol}`).join(" + ");

export function stamp(t = new Date()): string {
  return `[${t.toISOString()}]`;
}

export function headline(a: Assessment): string {
  const s = a.loan.snap;
  return `${a.level.toUpperCase()} ${s.venue} ${short(s.wallet)}: health ${hfText(s.hf)} (debt ${legs(s.debt)}, collateral ${legs(s.collateral)})`;
}

export function priceLine(a: Assessment): string {
  const s = a.loan.snap;
  const owedTokens = new Set(s.debt.map((d) => d.token.toLowerCase()));
  const steady = s.collateral.filter((c) => c.lt > 0 && c.priceShape !== "moving" && !owedTokens.has(c.token.toLowerCase()));
  const parts: string[] = [];
  if (a.drop !== null) {
    const moving = movingCollateral(s).map((c) => c.symbol).join("/");
    parts.push(a.drop >= 1 ? `even if ${moving} went to zero the rest of the collateral still covers the debt` : `liquidated if ${moving} falls ${pct(a.drop, 1)} further`);
  }
  const hedged = s.collateral.filter((c) => c.lt > 0 && owedTokens.has(c.token.toLowerCase()));
  if (hedged.length) parts.push(`${hedged.map((c) => c.symbol).join("/")} is posted against a ${hedged.map((c) => c.symbol).join("/")} loan, its price cancels out`);
  for (const c of steady) {
    parts.push(c.priceShape === "flat"
      ? `${c.symbol} oracle didn't move in 7 days`
      : `${c.symbol} oracle only climbed in 7 days (${pct(c.trendApr)}/yr, NAV-style), so a price drop isn't the risk here`);
  }
  return parts.join("; ");
}

function clockText(c: Clock): string {
  if (c.days === null) return `health is growing on its own (collateral ${pct(c.collateralGrowth)}/yr vs debt ${pct(c.debtGrowth)}/yr)`;
  if (c.days === 0) return "already past the line";
  const when = c.days > 3650 ? "more than 10 years" : `about ${Math.round(c.days)} days`;
  return `health shrinks ${pct(-c.net)}/yr (collateral ${pct(c.collateralGrowth)} vs debt ${pct(c.debtGrowth)}), ${when} to liquidation if nothing else moves`;
}

export function clockLines(a: Assessment): string[] {
  const out = [`carry now: ${clockText(a.clockNow)}`];
  const stressed = a.loan.snap.debt.some((d) => d.stressApr !== undefined && d.stressApr !== d.apr);
  if (stressed) out.push(`carry if every spare unit of supply left the market (borrow ${pct(a.clockStress.debtGrowth)}): ${clockText(a.clockStress)}`);
  return out;
}

function adviceText(x: Advice, s: Snapshot): string {
  const what = `${x.move.kind === "repay" ? "repay" : "add"} ${amount(x.move.amount, x.move.leg.decimals)} ${x.move.leg.symbol}${x.move.kind === "add" ? " collateral" : ""}`;
  const r = x.rehearsal;
  const has = `you hold ${amount(r.walletHas, x.move.leg.decimals)} ${x.move.leg.symbol}${r.walletHas >= x.move.amount ? ", enough" : ""}`;
  if (!r.ok) return `${what} (expected health ${hfText(x.move.expectedHf)}; rehearsal failed: ${r.why}; ${has})`;
  return `${what} -> health ${hfText(r.hfAfter!)} (rehearsed on the real ${s.kind === "aave" ? "pool" : "Morpho contract"} at block ${s.block}; ${has})`;
}

export function actionLine(a: Assessment): string {
  const s = a.loan.snap;
  if (a.advice.length === 0) return `act: nothing needed, health is above ${a.aim.toFixed(2)}`;
  const why = a.aim > 1.5000001 && a.clockNow.days !== null ? ` (aiming at ${a.aim.toFixed(3)} because the carry shrinks health)` : ` to get back to ${a.aim.toFixed(2)}`;
  return `act${why}: ${a.advice.map((x) => adviceText(x, s)).join("  OR  ")}`;
}

/** The full alert, one line per idea. */
export function alertText(a: Assessment, reason?: string): string {
  return [
    `${reason ? `${reason}: ` : ""}${headline(a)}`,
    priceLine(a),
    ...clockLines(a),
    actionLine(a),
    `rules: ${a.keys}`,
  ].filter(Boolean).join("\n");
}

export function table(rows: Assessment[]): string {
  const head = "# | venue | wallet | health | level | price risk | days left (now / stress) | debt";
  const lines = rows.map((a, i) => {
    const s = a.loan.snap;
    const days = (c: Clock) => (c.days === null ? "growing" : c.days > 3650 ? ">10y" : `${Math.round(c.days)}`);
    const risk = a.drop === null ? "no price risk" : a.drop >= 1 ? "covered" : `-${pct(a.drop, 1)}`;
    return `${i + 1} | ${s.venue} | ${short(s.wallet)} | ${hfText(s.hf)} | ${a.level} | ${risk} | ${days(a.clockNow)} / ${days(a.clockStress)} | ${money(s.debt.reduce((x, d) => x + d.value, 0), s.quote)}`;
  });
  return [head, ...lines].join("\n");
}
