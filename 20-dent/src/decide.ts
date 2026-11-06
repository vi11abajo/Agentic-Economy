// The arithmetic of "is it worth moving". Pure: numbers in, verdict out, so every rule is tested without a chain.
//
// Rates are compared window by window (now, last 7 days, last 30 days), and the window worst for the move is the
// one that counts. Comparing like with like matters: Faroo vaults and stPROS both ride the stPROS rate, and taking
// one side's best week against the other side's worst month would call a free upgrade a loss. A destination's
// rate is also capped, in every window, by what it would pay with your deposit in it.

export interface Place {
  id: string;
  name: string;
  status: "open" | "closed" | "unreadable";
  why?: string;
  /** Earns this in every window (money sitting in the wallet: 0). */
  fixedRate?: number;
  rateNow?: number;
  rateWithYou?: number;
  realized7d?: number;
  realized30d?: number;
  entryFee: number;
  exitFee: number;
  exitRoom?: number;
  /** Getting out is impossible right now, and this is why. */
  exitBlocked?: string;
  entryRoom?: number;
  waitSeconds: number;
}

export interface Costs {
  /** Gas for the whole move (exit + entry), in lane units (USDC or PROS). Undefined if it couldn't be estimated. */
  gas?: number;
  gasWhy?: string;
  /** Unbonding wait on the way to this destination, when it differs from the source's own (Faroo vault -> stPROS: none). */
  waitSeconds?: number;
}

export interface Option {
  id: string;
  name: string;
  verdict: "candidate" | "skip";
  why: string;
  rateUsed?: number;
  rateHow?: string;
  /** Your current place's rate in the same window. */
  fromRate?: number;
  earningDays?: number;
  extraYield?: number;
  fees?: number;
  gas?: number;
  net?: number;
  breakEvenDays?: number | null;
}

export interface Decision {
  action: "MOVE" | "STAY PUT";
  to?: string;
  reason: string;
  from: { id: string; name: string };
  amount: number;
  holdDays: number;
  minGain: number;
  options: Option[];
}

const DAY = 86400;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
/** Short, readable amounts: 6 significant digits is plenty for a verdict line. */
export const amt = (x: number) => Number(x.toPrecision(6)).toString();
export const days = (n: number) => (n === 1 ? "1 day" : `${n} days`);

type Win = "now" | "7d" | "30d";
const WIN_LABEL: Record<Win, string> = { now: "now", "7d": "over the last 7 days", "30d": "over the last 30 days" };

/** A place's rate in each window. For a destination, every window is capped by its rate with your money in it. */
export function windowRates(p: Place, asDestination: boolean): Partial<Record<Win, number>> {
  if (p.fixedRate !== undefined) return { now: p.fixedRate, "7d": p.fixedRate, "30d": p.fixedRate };
  const cap = asDestination ? p.rateWithYou : undefined;
  const capped = (x: number | undefined) => (x === undefined ? undefined : cap === undefined ? x : Math.min(x, cap));
  const out: Partial<Record<Win, number>> = {};
  const now = asDestination ? (p.rateWithYou ?? p.rateNow) : p.rateNow;
  if (now !== undefined) out.now = now;
  if (p.realized7d !== undefined) out["7d"] = capped(p.realized7d);
  if (p.realized30d !== undefined) out["30d"] = capped(p.realized30d);
  return out;
}

/** The window where the destination beats the source by the least (or loses by the most). */
export function compareRates(from: Place, to: Place): { rFrom: number; rTo: number; how: string } | undefined {
  const a = windowRates(from, false);
  const b = windowRates(to, true);
  let best: { rFrom: number; rTo: number; how: string } | undefined;
  for (const w of ["now", "7d", "30d"] as Win[]) {
    const x = a[w];
    const y = b[w];
    if (x === undefined || y === undefined) continue;
    const rTo = Math.max(0, y);
    if (!best || rTo - x < best.rTo - best.rFrom) best = { rFrom: x, rTo, how: `${WIN_LABEL[w]}${w === "now" && to.rateWithYou !== undefined ? ", with your deposit in it" : ""}` };
  }
  return best;
}

/**
 * Net result of moving `amount` from `from` to `to` and holding `days`, compared with staying.
 * Waiting to get out (unbonding) earns nothing; fees come off the principal; gas is paid once.
 */
export function netOfMove(amount: number, rFrom: number, rTo: number, exitFee: number, entryFee: number, waitDays: number, gas: number, days: number) {
  const landed = amount * (1 - exitFee) * (1 - entryFee);
  const earning = Math.max(0, days - waitDays);
  const moved = landed * (1 + (rTo * earning) / 365) - gas;
  const stayed = amount * (1 + (rFrom * days) / 365);
  return { net: moved - stayed, earning, fees: amount - landed, extraYield: (landed * rTo * earning - amount * rFrom * days) / 365 };
}

/** Fewest days of holding after which the move has paid for itself; null if it never does. */
export function breakEven(amount: number, rFrom: number, rTo: number, exitFee: number, entryFee: number, waitDays: number, gas: number): number | null {
  const landed = amount * (1 - exitFee) * (1 - entryFee);
  // net(d) = landed*(1 + rTo*(d-w)/365) - gas - amount*(1 + rFrom*d/365), linear in d for d >= w
  const slope = (landed * rTo - amount * rFrom) / 365;
  const atWait = netOfMove(amount, rFrom, rTo, exitFee, entryFee, waitDays, gas, waitDays).net;
  if (atWait >= 0) return Math.ceil(waitDays);
  if (slope <= 0) return null;
  return Math.ceil(waitDays + -atWait / slope);
}

export function decide(input: {
  from: Place;
  amount: number;
  places: Place[];
  costs: Record<string, Costs>;
  holdDays: number;
  minGain: number;
}): Decision {
  const { from, amount, places, costs, holdDays, minGain } = input;
  const out: Option[] = [];
  const waitDays = from.waitSeconds / DAY;

  const blocked = from.exitBlocked ?? (from.exitRoom !== undefined && from.exitRoom < amount ? "cash" : undefined);
  if (blocked) {
    const why = from.exitBlocked ? `can't leave ${from.name} right now: ${from.exitBlocked}` : `${from.name} has only ${amt(from.exitRoom!)} free to withdraw right now, less than the ${amt(amount)} you'd move`;
    for (const p of places) if (p.id !== from.id) out.push({ id: p.id, name: p.name, verdict: "skip", why: "can't leave the current place" });
    return { action: "STAY PUT", reason: why, from: { id: from.id, name: from.name }, amount, holdDays, minGain, options: out };
  }

  for (const p of places) {
    if (p.id === from.id) continue;
    const base = { id: p.id, name: p.name };
    if (p.status !== "open") {
      out.push({ ...base, verdict: "skip", why: p.status === "closed" ? `closed: ${p.why}` : `can't read it: ${p.why}` });
      continue;
    }
    if (p.entryRoom !== undefined && p.entryRoom < amount) {
      out.push({ ...base, verdict: "skip", why: `supply cap leaves room for only ${amt(p.entryRoom)}` });
      continue;
    }
    const cmp = compareRates(from, p);
    if (!cmp) {
      out.push({ ...base, verdict: "skip", why: "no rate in a window both places have" });
      continue;
    }
    const dst = { rate: cmp.rTo, how: cmp.how };
    const src = { rate: cmp.rFrom };
    const c = costs[p.id];
    if (!c || c.gas === undefined) {
      out.push({ ...base, verdict: "skip", why: `gas unknown: ${c?.gasWhy ?? "not estimated"}`, rateUsed: dst.rate, rateHow: dst.how });
      continue;
    }
    const wait = c.waitSeconds !== undefined ? c.waitSeconds / DAY : waitDays;
    const m = netOfMove(amount, src.rate, dst.rate, from.exitFee, p.entryFee, wait, c.gas, holdDays);
    const be = breakEven(amount, src.rate, dst.rate, from.exitFee, p.entryFee, wait, c.gas);
    const opt: Option = {
      ...base,
      verdict: "candidate",
      why: "",
      rateUsed: dst.rate,
      rateHow: dst.how,
      fromRate: src.rate,
      earningDays: m.earning,
      extraYield: m.extraYield,
      fees: m.fees,
      gas: c.gas,
      net: m.net,
      breakEvenDays: be,
    };
    if (dst.rate <= src.rate) opt.why = `pays ${pct(dst.rate)} ${dst.how}, not more than the ${pct(src.rate)} you get in the same window`;
    else if (be === null) opt.why = "never pays back the cost of moving";
    else if (be > holdDays) opt.why = `pays back only after ${days(be)}, longer than your ${holdDays}-day hold`;
    else if (m.net < minGain) opt.why = `nets ${amt(m.net)} over ${days(holdDays)}, below your minimum gain of ${minGain}`;
    else opt.why = `nets ${amt(m.net)} over ${days(holdDays)}, pays back in ${days(be)}`;
    out.push(opt);
  }

  const winners = out
    .filter((o) => o.verdict === "candidate" && o.net !== undefined && o.net >= minGain && o.breakEvenDays !== null && (o.breakEvenDays ?? Infinity) <= holdDays && (o.rateUsed ?? 0) > (o.fromRate ?? 0))
    .sort((a, b) => b.net! - a.net!);
  const fromInfo = { id: from.id, name: from.name };
  if (winners.length) {
    const w = winners[0];
    return { action: "MOVE", to: w.id, reason: `${w.name}: ${w.why}`, from: fromInfo, amount, holdDays, minGain, options: out };
  }
  const best = out.filter((o) => o.verdict === "candidate").sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity))[0];
  const reason = best ? `best alternative ${best.name} ${best.why}` : "no open place to move to";
  return { action: "STAY PUT", reason, from: fromInfo, amount, holdDays, minGain, options: out };
}
