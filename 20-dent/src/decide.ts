// The arithmetic of "is it worth moving". Pure: numbers in, verdict out, so every rule is tested without a chain.
//
// We are generous to where the money is now and stingy to where it would go: the current place is credited the
// better of its quoted and realised rates, a destination the worse of its rate-with-you and realised rates.
// A move has to win even then.

export interface Place {
  id: string;
  name: string;
  status: "open" | "closed" | "unreadable";
  why?: string;
  rateNow?: number;
  rateWithYou?: number;
  realized7d?: number;
  realized30d?: number;
  entryFee: number;
  exitFee: number;
  exitRoom?: number;
  entryRoom?: number;
  waitSeconds: number;
}

export interface Costs {
  /** Gas for the whole move (exit + entry), in lane units (USDC or PROS). Undefined if it couldn't be estimated. */
  gas?: number;
  gasWhy?: string;
}

export interface Option {
  id: string;
  name: string;
  verdict: "candidate" | "skip";
  why: string;
  rateUsed?: number;
  rateHow?: string;
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
  from: { id: string; name: string; rateUsed: number; rateHow: string };
  amount: number;
  holdDays: number;
  minGain: number;
  options: Option[];
}

const DAY = 86400;
const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
/** Short, readable amounts: 6 significant digits is plenty for a verdict line. */
export const amt = (x: number) => Number(x.toPrecision(6)).toString();

/** The current place is credited its best plausible rate. */
export function sourceRate(p: Place): { rate: number; how: string } {
  const c: [number, string][] = [];
  if (p.rateNow !== undefined) c.push([p.rateNow, "quoted now"]);
  if (p.realized7d !== undefined) c.push([p.realized7d, "realised over 7 days"]);
  if (p.realized30d !== undefined) c.push([p.realized30d, "realised over 30 days"]);
  if (!c.length) return { rate: 0, how: "no rate readable, taken as 0" };
  c.sort((a, b) => b[0] - a[0]);
  return { rate: c[0][0], how: c[0][1] };
}

/** A destination is credited its worst plausible rate, with your money already in it. */
export function destinationRate(p: Place): { rate: number; how: string } | undefined {
  const c: [number, string][] = [];
  if (p.rateWithYou !== undefined) c.push([p.rateWithYou, "with your deposit in it"]);
  else if (p.rateNow !== undefined) c.push([p.rateNow, "quoted now"]);
  if (p.realized7d !== undefined) c.push([p.realized7d, "realised over 7 days"]);
  if (p.realized30d !== undefined) c.push([p.realized30d, "realised over 30 days"]);
  if (!c.length) return undefined;
  c.sort((a, b) => a[0] - b[0]);
  return { rate: Math.max(0, c[0][0]), how: c[0][1] };
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
  const src = sourceRate(from);
  const out: Option[] = [];
  const waitDays = from.waitSeconds / DAY;

  if (from.exitRoom !== undefined && from.exitRoom < amount) {
    const why = `${from.name} has only ${amt(from.exitRoom)} free to withdraw right now, less than the ${amt(amount)} you'd move`;
    for (const p of places) if (p.id !== from.id) out.push({ id: p.id, name: p.name, verdict: "skip", why: "can't leave the current place" });
    return { action: "STAY PUT", reason: why, from: { id: from.id, name: from.name, rateUsed: src.rate, rateHow: src.how }, amount, holdDays, minGain, options: out };
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
    const dst = destinationRate(p);
    if (!dst) {
      out.push({ ...base, verdict: "skip", why: "no rate to compare" });
      continue;
    }
    const c = costs[p.id];
    if (!c || c.gas === undefined) {
      out.push({ ...base, verdict: "skip", why: `gas unknown: ${c?.gasWhy ?? "not estimated"}`, rateUsed: dst.rate, rateHow: dst.how });
      continue;
    }
    const m = netOfMove(amount, src.rate, dst.rate, from.exitFee, p.entryFee, waitDays, c.gas, holdDays);
    const be = breakEven(amount, src.rate, dst.rate, from.exitFee, p.entryFee, waitDays, c.gas);
    const opt: Option = {
      ...base,
      verdict: "candidate",
      why: "",
      rateUsed: dst.rate,
      rateHow: dst.how,
      earningDays: m.earning,
      extraYield: m.extraYield,
      fees: m.fees,
      gas: c.gas,
      net: m.net,
      breakEvenDays: be,
    };
    if (dst.rate <= src.rate) opt.why = `pays ${pct(dst.rate)} (${dst.how}), not more than the ${pct(src.rate)} you have`;
    else if (be === null) opt.why = "never pays back the cost of moving";
    else if (be > holdDays) opt.why = `pays back only after ${be} days, longer than your ${holdDays}-day hold`;
    else if (m.net < minGain) opt.why = `nets ${amt(m.net)} over ${holdDays} days, below your minimum gain of ${minGain}`;
    else opt.why = `nets ${amt(m.net)} over ${holdDays} days, pays back in ${be} days`;
    out.push(opt);
  }

  const winners = out
    .filter((o) => o.verdict === "candidate" && o.net !== undefined && o.net >= minGain && o.breakEvenDays !== null && (o.breakEvenDays ?? Infinity) <= holdDays && (o.rateUsed ?? 0) > src.rate)
    .sort((a, b) => b.net! - a.net!);
  const fromInfo = { id: from.id, name: from.name, rateUsed: src.rate, rateHow: src.how };
  if (winners.length) {
    const w = winners[0];
    return { action: "MOVE", to: w.id, reason: `${w.name}: ${w.why}`, from: fromInfo, amount, holdDays, minGain, options: out };
  }
  const best = out.filter((o) => o.verdict === "candidate").sort((a, b) => (b.net ?? -Infinity) - (a.net ?? -Infinity))[0];
  const reason = best ? `best alternative ${best.name} ${best.why}` : "no open place to move to";
  return { action: "STAY PUT", reason, from: fromInfo, amount, holdDays, minGain, options: out };
}
