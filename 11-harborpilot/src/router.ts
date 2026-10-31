// The routing decision, kept pure: quotes in, a ranking plus a reason for every venue out. No chain access here,
// so the same quotes always give the same answer.
import type { Quote } from "./adapters.js";

export interface Conditions {
  /** USDC to deposit. */
  amount: number;
  /** The longest the user can wait to get the money back, in days. Undefined: any. */
  maxExitDays?: number;
  /** Accept venues where the deposit itself is a request filled later. */
  allowAsyncDeposit: boolean;
  /** Skip venues whose share price fell over the last 7 or 30 days. */
  stableOnly: boolean;
  /** How long the money stays: a one-off exit fee is spread over it. */
  horizonDays: number;
  /** Country code; venues Harbor marks "not for <code>" are skipped. */
  region?: string;
}

export const DEFAULT_CONDITIONS: Omit<Conditions, "amount"> = { allowAsyncDeposit: true, stableOnly: false, horizonDays: 90 };

export interface Ranked {
  quote: Quote;
  /** The yield used: the lower of the 7-day and 30-day realized yield. */
  apy: number;
  /** apy minus the exit fee spread over the horizon. */
  net: number;
}

export interface Route {
  ranked: Ranked[];
  excluded: { quote: Quote; why: string }[];
  down: { quote: Quote; why: string }[];
  explanation: string[];
}

const pct = (x: number) => `${x.toFixed(2)}%`;
const usd = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 2 });

/** The yield a venue is ranked on: the lower of its 7-day and 30-day realized yield (the cautious one). */
export function rankedApy(q: Quote): number | undefined {
  const xs = [q.apy.d7, q.apy.d30].filter((x): x is number => x !== undefined && Number.isFinite(x));
  return xs.length ? Math.min(...xs) : undefined;
}

export function whyExcluded(q: Quote, c: Conditions): string | null {
  if (q.status === "closed") {
    if (q.venue.kind === "token-only") return q.reason ?? "no deposit contract on Pharos";
    const access = /KYB/i.test(q.venue.harbor.access) ? " (Harbor: KYB required)" : "";
    return `not taking this deposit now: ${q.reason ?? "closed"}${access}`;
  }
  if (q.minDeposit !== undefined && c.amount < q.minDeposit) return `minimum deposit is ${usd(q.minDeposit)} USDC`;
  if (c.region && new RegExp(`not for ${c.region}\\b`, "i").test(q.venue.harbor.regions)) return `Harbor: ${q.venue.harbor.regions}`;
  if (q.asyncDeposit && !c.allowAsyncDeposit) return "the deposit is a request filled later, and you want it filled at once";
  if (c.maxExitDays !== undefined) {
    if (q.exitDays === undefined) return `exit time is not stated (${q.exitHow})`;
    if (q.exitDays > c.maxExitDays) return `money comes back after ${q.exitDays} day(s), you want it within ${c.maxExitDays}`;
  }
  if (q.exitLiquidity !== undefined && c.amount > q.exitLiquidity) return `only ${usd(q.exitLiquidity)} USDC can leave it right now`;
  const apy = rankedApy(q);
  if (apy === undefined) return "no yield history yet";
  if (c.stableOnly && ((q.apy.d7 ?? 0) < 0 || (q.apy.d30 ?? 0) < 0)) return "its share price fell over the last 7 or 30 days, and you want a steady one";
  return null;
}

export function route(quotes: Quote[], c: Conditions): Route {
  const ranked: Ranked[] = [];
  const excluded: Route["excluded"] = [];
  const down: Route["down"] = [];
  for (const q of quotes) {
    if (q.status === "down") {
      down.push({ quote: q, why: q.reason ?? "no answer" });
      continue;
    }
    const why = whyExcluded(q, c);
    if (why) {
      excluded.push({ quote: q, why });
      continue;
    }
    const apy = rankedApy(q)!;
    ranked.push({ quote: q, apy, net: apy - (q.exitFeePct * 365) / c.horizonDays });
  }
  ranked.sort((a, b) => b.net - a.net || (b.quote.tvl ?? 0) - (a.quote.tvl ?? 0));

  const explanation: string[] = [];
  const [best, second] = ranked;
  if (best) {
    const q = best.quote;
    const windows = [q.apy.d7 !== undefined ? `7d ${pct(q.apy.d7)}` : "", q.apy.d30 !== undefined ? `30d ${pct(q.apy.d30)}` : ""].filter(Boolean).join(", ");
    explanation.push(`${q.venue.name} pays ${pct(best.apy)} a year, the lower of its realized yields (${windows}).`);
    if (q.exitFeePct) explanation.push(`Its ${q.exitFeePct}% exit fee spread over ${c.horizonDays} days leaves ${pct(best.net)}.`);
    explanation.push(`Exit: ${q.exitHow}.`);
    if (second) explanation.push(`That is ${(best.net - second.net).toFixed(2)} points above the next one, ${second.quote.venue.name} (${pct(second.net)}).`);
    else explanation.push("It is the only venue that fits your conditions.");
  } else {
    explanation.push("No Harbor venue fits these conditions right now. The reasons for each one are below.");
  }
  if (down.length) explanation.push(`${down.length} venue(s) didn't answer and were left out; the rest were compared without them.`);
  return { ranked, excluded, down, explanation };
}
