// The decision logic. Pure functions over a market snapshot and the user's thresholds, so every rule is
// unit-tested. Buy: all checks must pass (APE), else NOPE. Sell: any rule that fires says EXIT, else HOLD.
// Missing data never leads to a trade: a buy check we can't read fails, a sell rule we can't read stays quiet.
import type { MarketSnapshot } from "./chain.js";
import { KEYS, formatValue, type Config, type Key } from "./config.js";
import { MAX_FEED_AGE_SEC } from "./prosper.js";

export interface Check {
  key: string;
  label: string;
  value: string;
  limit: string;
  /** buy: true = pass. sell: true = no exit signal. null = couldn't read it. */
  ok: boolean | null;
  source: string;
  advisory?: boolean;
}

export interface Decision {
  side: "buy" | "sell";
  verdict: "APE" | "NOPE" | "EXIT" | "HOLD";
  /** true when the guardian says act (APE / EXIT). */
  fire: boolean;
  /** An advisory check flagged: the agent must ask the user before trading. */
  needsApproval: boolean;
  reason: string;
  checks: Check[];
}

export interface Position {
  wallet: string;
  token: string;
  market: string;
  symbol: string;
  /** PROS paid for the tokens still held (average cost). */
  cost: number;
  tokens: number;
  /** State of the market when the position was opened (or first tracked). */
  reserve: number;
  holders: number | null;
  block: number;
  timestamp: number;
  source: "trenchscope buy" | "found on chain" | "entered by user";
}

const v = (c: Config, k: Key) => c.values[k] ?? null;
const lim = (c: Config, k: Key) => formatValue(v(c, k), KEYS[k].unit);
const pct = (n: number, d = 1) => `${n.toFixed(d)}%`;
const signed = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(1)}%`;
export const usd = (n: number) => `$${Math.round(n).toLocaleString("en-US")}`;
export const pros = (n: number) => `${n >= 100 ? n.toFixed(1) : n >= 1 ? n.toFixed(3) : n.toPrecision(3)} PROS`;

/** Holders that are real traders: not a Prosper wallet from the token's creation, not you, not dust. */
export function realHolders(s: MarketSnapshot, minPros: number, me: string | null) {
  if (!s.holders || !s.protocol) return null;
  const skip = new Set([...s.protocol, me?.toLowerCase() ?? ""]);
  return s.holders.filter((h) => !skip.has(h.address) && h.balance > 0 && h.balance * s.spot >= minPros);
}

/** The biggest bag outside Prosper's own wallets (and yours), contracts included: a stranger's contract with 7% is a red flag too. */
export function topHolder(s: MarketSnapshot, me: string | null) {
  if (!s.holders || !s.protocol) return null;
  const skip = new Set([...s.protocol, me?.toLowerCase() ?? ""]);
  const rest = s.holders.filter((h) => !skip.has(h.address)).sort((a, b) => b.balance - a.balance);
  if (rest.length === 0) return { address: null as string | null, pct: 0, isContract: false };
  return { address: rest[0].address, pct: (rest[0].balance / s.supply) * 100, isContract: rest[0].isContract };
}

const HOLDERS_SRC = "pharosscan holders, Prosper wallets from the creation tx excluded";
const holdersNa = (s: MarketSnapshot) => (s.holders ? "n/a (creation split not found)" : `n/a (${s.holdersError ?? "explorer unavailable"})`);

export function fdvUsd(s: MarketSnapshot): number | null {
  if (s.prosUsd === null || s.prosUsdAge === null || s.prosUsdAge > MAX_FEED_AGE_SEC) return null;
  return s.spot * s.supply * s.prosUsd;
}

export function evaluateBuy(s: MarketSnapshot, c: Config, size: { pros: number; net: number; tokensOut: number }, me: string | null): Decision {
  const checks: Check[] = [];
  const minPros = v(c, "holder_min_pros") ?? 0;

  if (v(c, "max_fdv_usd") !== null) {
    const fdv = fdvUsd(s);
    checks.push({
      key: "max_fdv_usd", label: "FDV", limit: `<= ${lim(c, "max_fdv_usd")}`,
      value: fdv === null ? `n/a (PROS/USD feed ${s.prosUsdAge === null ? "unreadable" : `is ${Math.round(s.prosUsdAge / 60)} min old`})` : usd(fdv),
      ok: fdv === null ? null : fdv <= v(c, "max_fdv_usd")!,
      source: "quoteBuy x supply x Chainlink PROS/USD",
    });
  }
  if (v(c, "min_holders") !== null) {
    const real = realHolders(s, minPros, me);
    checks.push({
      key: "min_holders", label: "holders", limit: `>= ${v(c, "min_holders")} (bag >= ${formatValue(minPros, "pros")})`,
      value: real ? String(real.length) : holdersNa(s),
      ok: real ? real.length >= v(c, "min_holders")! : null,
      source: HOLDERS_SRC,
    });
  }
  if (v(c, "max_holder_share_pct") !== null) {
    const top = topHolder(s, me);
    checks.push({
      key: "max_holder_share_pct", label: "top holder", limit: `<= ${lim(c, "max_holder_share_pct")}`,
      value: top ? (top.address ? `${pct(top.pct, 2)} (${top.address.slice(0, 6)}…${top.address.slice(-4)}${top.isContract ? ", contract" : ""})` : "nobody yet") : holdersNa(s),
      ok: top ? top.pct <= v(c, "max_holder_share_pct")! : null,
      source: HOLDERS_SRC,
    });
  }
  if (v(c, "min_time_left_hours") !== null) {
    const hours = (s.endsAt - s.timestamp) / 3600;
    checks.push({
      key: "min_time_left_hours", label: "time left", limit: `>= ${lim(c, "min_time_left_hours")}`,
      value: hours <= 0 ? "ended" : hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`,
      ok: hours >= v(c, "min_time_left_hours")!,
      source: "market endsAt() vs block time",
    });
  }
  if (v(c, "max_progress_pct") !== null) {
    const p = s.target > 0 ? (s.reserve / s.target) * 100 : null;
    checks.push({
      key: "max_progress_pct", label: "progress", limit: `<= ${lim(c, "max_progress_pct")}`,
      value: p === null ? "n/a (no graduation target)" : `${pct(p, 2)} (${pros(s.reserve)} of ${s.target.toLocaleString("en-US")})`,
      ok: p === null ? null : p <= v(c, "max_progress_pct")!,
      source: "WPROS in the curve / graduation target",
    });
  }
  if (v(c, "advise_max_price_impact_pct") !== null) {
    const impact = size.tokensOut > 0 ? (size.net / size.tokensOut / s.spot - 1) * 100 : null;
    checks.push({
      key: "advise_max_price_impact_pct", label: "price impact", advisory: true, limit: `<= ${lim(c, "advise_max_price_impact_pct")}`,
      value: impact === null ? "n/a" : `${pct(impact, 2)} on ${pros(size.pros)}`,
      ok: impact === null ? null : impact <= v(c, "advise_max_price_impact_pct")!,
      source: "quoteBuy on your size vs a tiny quote",
    });
  }

  const decisive = checks.filter((x) => !x.advisory);
  const failed = decisive.filter((x) => x.ok === false);
  const unread = decisive.filter((x) => x.ok === null);
  const advice = checks.find((x) => x.advisory && x.ok === false);
  if (failed.length || unread.length) {
    const why = [
      ...failed.map((x) => `${x.label} ${x.value}, limit ${x.limit}`),
      ...unread.map((x) => `couldn't check ${x.label}: ${x.value}`),
    ];
    return { side: "buy", verdict: "NOPE", fire: false, needsApproval: false, reason: why.join("; "), checks };
  }
  return {
    side: "buy", verdict: "APE", fire: true, needsApproval: !!advice, checks,
    reason: advice ? `all ${decisive.length} checks pass, but ${advice.label} is ${advice.value} (advice ${advice.limit})` : `all ${decisive.length} checks pass`,
  };
}

export function evaluateSell(s: MarketSnapshot, c: Config, pos: Position, bag: { tokens: number; value: number }, me: string | null): Decision {
  const checks: Check[] = [];
  const minPros = v(c, "holder_min_pros") ?? 0;
  const tp = v(c, "take_profit_pct");
  const sl = v(c, "stop_loss_pct");

  if (tp !== null || sl !== null) {
    const pnl = pos.cost > 0 ? (bag.value / pos.cost - 1) * 100 : null;
    const hitTp = pnl !== null && tp !== null && pnl >= tp;
    const hitSl = pnl !== null && sl !== null && pnl <= -sl;
    checks.push({
      key: "pnl", label: hitSl ? "stop loss" : hitTp ? "take profit" : "P&L",
      limit: [tp !== null ? `TP +${tp}%` : "", sl !== null ? `SL -${sl}%` : ""].filter(Boolean).join(" / "),
      value: pnl === null ? "n/a (unknown entry cost)" : `${signed(pnl)} (${pros(bag.value)} now vs ${pros(pos.cost)} paid)`,
      ok: pnl === null ? null : !(hitTp || hitSl),
      source: "quoteSell on your bag vs your entry",
    });
  }
  if (v(c, "max_reserve_drop_pct") !== null) {
    const drop = pos.reserve > 0 ? ((pos.reserve - s.reserve) / pos.reserve) * 100 : null;
    checks.push({
      key: "max_reserve_drop_pct", label: "liquidity drain", limit: `< ${lim(c, "max_reserve_drop_pct")} drop`,
      value: drop === null ? "n/a" : `${Math.abs(drop) < 0.05 ? "" : drop > 0 ? "-" : "+"}${pct(Math.abs(drop))} (${pros(s.reserve)} now, ${pros(pos.reserve)} at entry)`,
      ok: drop === null ? null : drop < v(c, "max_reserve_drop_pct")!,
      source: "WPROS in the curve vs at entry",
    });
  }
  if (v(c, "max_holder_drop") !== null) {
    const now = realHolders(s, minPros, me);
    const left = now && pos.holders !== null ? pos.holders - now.length : null;
    checks.push({
      key: "max_holder_drop", label: "holder exodus", limit: `< ${v(c, "max_holder_drop")} left`,
      value: left === null ? (now ? "n/a (no holder count at entry)" : holdersNa(s)) : `${now!.length} now, ${pos.holders} at entry`,
      ok: left === null ? null : left < v(c, "max_holder_drop")!,
      source: HOLDERS_SRC,
    });
  }
  if (v(c, "max_whale_share_pct") !== null) {
    const top = topHolder(s, me);
    checks.push({
      key: "max_whale_share_pct", label: "whale", limit: `<= ${lim(c, "max_whale_share_pct")}`,
      value: top ? (top.address ? `${pct(top.pct, 2)} (${top.address.slice(0, 6)}…${top.address.slice(-4)}${top.isContract ? ", contract" : ""})` : "nobody") : holdersNa(s),
      ok: top ? top.pct <= v(c, "max_whale_share_pct")! : null,
      source: HOLDERS_SRC,
    });
  }
  if (v(c, "advise_max_slippage_pct") !== null) {
    const fair = bag.tokens * s.spot;
    const slip = fair > 0 ? (1 - bag.value / fair) * 100 : null;
    checks.push({
      key: "advise_max_slippage_pct", label: "slippage", advisory: true, limit: `<= ${lim(c, "advise_max_slippage_pct")}`,
      value: slip === null ? "n/a" : `${pct(slip, 2)} incl. 1% fee`,
      ok: slip === null ? null : slip <= v(c, "advise_max_slippage_pct")!,
      source: "quoteSell on the whole bag vs spot",
    });
  }

  const fired = checks.find((x) => !x.advisory && x.ok === false);
  const advice = checks.find((x) => x.advisory && x.ok === false);
  if (!fired) {
    const quiet = checks.filter((x) => !x.advisory && x.ok === null).map((x) => x.label);
    return { side: "sell", verdict: "HOLD", fire: false, needsApproval: false, checks, reason: quiet.length ? `no exit signal (couldn't read: ${quiet.join(", ")})` : "no exit signal" };
  }
  return {
    side: "sell", verdict: "EXIT", fire: true, needsApproval: !!advice, checks,
    reason: `${fired.label}: ${fired.value}, limit ${fired.limit}${advice ? `; but selling it all costs ${advice.value} (advice ${advice.limit})` : ""}`,
  };
}
