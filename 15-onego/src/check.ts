// check: run the whole batch on mainnet state before anything is signed for real, and say what each action
// would do. The wallet's money is mirrored into the simulation: its real PROS (or a "what if" amount), and its
// real USDC handed to a throwaway signer, so the USDC payments are tested without creating live signatures.
import { decodeErrorResult, decodeFunctionResult, encodeFunctionData, toHex, type Address, type Hex, type LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildBatch, encodeBatch, sentData, type Authorization, type Step } from "./batch.js";
import { MULTICALL3, USDC, USDC_DECIMALS, USDC_SLOT, erc20Abi, multicall3Abi } from "./book.js";
import { mapSlot, type Chain, type Overrides } from "./chain.js";
import { oneByOne } from "./baseline.js";
import { quoteCurve, quotePool, resolveVenue, type Venue } from "./market.js";
import { toUnits, type Plan } from "./plan.js";

export type ActionResult = { action: number; label: string; ok: boolean; reason?: string; got?: { symbol: string; amount: bigint; decimals: number } };
export type CheckReport = {
  wallet: Address;
  results: ActionResult[];
  leftovers: Array<{ symbol: string; amount: bigint }>;
  batch: { txs: 1; gas: bigint | null; feePros: bigint | null; value: bigint };
  oneByOne: { txs: number; gas: bigint; feePros: bigint };
  warnings: string[];
  sendable: boolean;
  refusals: string[];
};
export type CheckOptions = {
  now: bigint;
  nonceFor: (i: number) => Hex;
  simKey?: Hex; // throwaway signer for a dry check
  signer?: LocalAccount; // the real wallet, when send() checks what it's about to broadcast
  whatIf?: { pros?: bigint; usdc?: bigint };
};
export type Built = { steps: Step[]; readBacks: Step[]; value: bigint; authorizations: Authorization[]; overrides: Overrides };

export const GAS_CAP = 30_000_000n; // far below the 1e9 block limit; a batch is never split, so it must fit
const PLENTY = 10n ** 27n; // for gas estimates only: gas doesn't depend on how rich the sender is

/** Turns revert bytes into words: Error(string), Panic, or at least the custom error's selector. */
export function explainRevert(data: Hex): string {
  if (!data || data === "0x") return "reverted without saying why";
  try {
    const e = decodeErrorResult({ abi: [], data });
    if (e.errorName === "Error") return String(e.args?.[0]);
    if (e.errorName === "Panic") return `panic ${String(e.args?.[0])}`;
  } catch {
    /* not a standard error */
  }
  return `reverted with custom error ${data.slice(0, 10)}`;
}

export function mergeOverrides(...parts: Overrides[]): Overrides {
  const out: Overrides = {};
  for (const part of parts)
    for (const [addr, o] of Object.entries(part) as Array<[Address, Overrides[Address]]>) {
      const key = addr.toLowerCase() as Address;
      const prev = out[key] ?? {};
      out[key] = { ...prev, ...o, ...(prev.stateDiff || o.stateDiff ? { stateDiff: { ...prev.stateDiff, ...o.stateDiff } } : {}) };
    }
  return out;
}

const pad32 = (n: bigint) => toHex(n, { size: 32 });
type Results = Array<{ success: boolean; returnData: Hex }>;

async function runBatch(chain: Chain, from: Address, steps: Step[], value: bigint, o: Overrides): Promise<{ ok: true; results: Results } | { ok: false; message: string }> {
  const r = await chain.call({ from, to: MULTICALL3, value, data: encodeBatch(steps) }, o);
  if (!r.ok) return { ok: false, message: explainRevert(r.revertData) };
  return { ok: true, results: decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3Value", data: r.data }) as Results };
}

export async function check(chain: Chain, plan: Plan, opts: CheckOptions): Promise<CheckReport & { built: Built }> {
  const warnings: string[] = [];
  const refusals: string[] = [];
  const signer = opts.signer ?? privateKeyToAccount(opts.simKey ?? (() => { throw new Error("check needs a simKey or a signer"); })());

  // 1. Where each buy goes and what it gets.
  const venues = new Map<number, Venue>();
  const quotes = new Map<number, { value: bigint; out: bigint }>();
  for (const [i, a] of plan.actions.entries()) {
    if (a.kind !== "buy") continue;
    const v = await resolveVenue(chain, a.token, a.market);
    venues.set(i, v);
    const pros = toUnits(a.pros, 18);
    if (v.kind === "pool") quotes.set(i, { value: pros, out: quotePool(v, pros) });
    else {
      const q = await quoteCurve(chain, v, pros);
      quotes.set(i, { value: q.usedGross, out: q.out });
      if (q.usedGross < pros) warnings.push(`${v.symbol}: the curve takes only ${fmt(q.usedGross, 18)} of the ${a.pros} PROS, so only that is sent`);
      if (v.failed) warnings.push(`${v.symbol}: its curve missed its goal (ended ${new Date(Number(v.endsAt) * 1000).toISOString().slice(0, 10)}) and will not move to a pool; it still sells on the curve`);
    }
  }

  // 2. The wallet's money, mirrored into the simulation.
  const usesUsdc = plan.actions.some((a) => a.kind === "send_usdc");
  const pros = opts.whatIf?.pros ?? (await chain.balance(plan.wallet));
  const usdc = !usesUsdc ? 0n : (opts.whatIf?.usdc ?? (await readUnits(chain, USDC, plan.wallet)));

  const built = await buildBatch({ plan, venues, quotes, signer, now: opts.now, nonceFor: opts.nonceFor });
  // The throwaway signer gets the wallet's USDC, and no code: if its address happened to carry code (a known test
  // key someone delegated through EIP-7702, say), USDC would check the signature the contract way and refuse it.
  const throwaway = signer.address.toLowerCase() !== plan.wallet.toLowerCase();
  const usdcMirror: Overrides = usesUsdc && throwaway ? { [USDC]: { stateDiff: { [mapSlot(signer.address, USDC_SLOT)]: pad32(usdc) } }, [signer.address]: { code: "0x" } } : {};
  const overrides = mergeOverrides(usdcMirror, { [plan.wallet]: { balance: toHex(pros > built.value ? pros : built.value) } });

  // 3. Balances before, then the real batch (actions + read-backs) in one go.
  const before = await runBatch(chain, plan.wallet, built.readBacks, 0n, overrides);
  if (!before.ok) throw new Error(`couldn't read balances: ${before.message}`);
  const all = [...built.steps, ...built.readBacks];
  let run = await runBatch(chain, plan.wallet, all, built.value, overrides);
  let wholeRevert = false;
  if (!run.ok) {
    // Multicall3 only says "call failed": rerun with every step allowed to fail to see which one, and why.
    wholeRevert = true;
    run = await runBatch(chain, plan.wallet, all.map((s) => ({ ...s, call: { ...s.call, allowFailure: true } })), built.value, overrides);
    if (!run.ok) throw new Error(`the batch can't even be simulated: ${run.message}`);
  }
  const res = run.results;

  const afterOf = new Map<string, bigint>();
  const beforeOf = new Map<string, bigint>();
  built.readBacks.forEach((rb, k) => {
    const key = `${rb.reads!.holder}|${rb.reads!.asset}`.toLowerCase();
    beforeOf.set(key, before.results[k].success ? BigInt(before.results[k].returnData) : 0n);
    const after = res[built.steps.length + k];
    afterOf.set(key, after.success ? BigInt(after.returnData) : 0n);
  });
  const delta = (holder: Address, asset: Address | "PROS") => {
    const key = `${holder}|${asset}`.toLowerCase();
    return (afterOf.get(key) ?? 0n) - (beforeOf.get(key) ?? 0n);
  };

  // 4. One line per action.
  const results: ActionResult[] = plan.actions.map((a, i) => {
    const mine = built.steps.map((s, k) => ({ s, r: res[k] })).filter((x) => x.s.action === i);
    const firstBad = mine.find((x) => !x.r.success);
    const label = a.kind === "buy" ? `buy ${venues.get(i)!.symbol} for ${a.pros} PROS` : `send ${a.amount} ${a.kind === "send_usdc" ? "USDC" : "PROS"} to ${a.to}`;
    if (firstBad) return { action: i, label, ok: false, reason: `${firstBad.s.label}: ${explainRevert(firstBad.r.returnData)}` };
    if (wholeRevert && mine.some((x) => !x.s.call.allowFailure)) return { action: i, label, ok: false, reason: "fine on its own, but another PROS step failed, so the whole transaction would revert" };
    if (a.kind === "send_usdc") return { action: i, label, ok: true, got: { symbol: "USDC", amount: delta(a.to, USDC), decimals: USDC_DECIMALS } };
    if (a.kind === "send_pros") return { action: i, label, ok: true, got: { symbol: "PROS", amount: delta(a.to, "PROS"), decimals: 18 } };
    return { action: i, label, ok: true, got: { symbol: venues.get(i)!.symbol, amount: quotes.get(i)!.out, decimals: 18 } };
  });

  // Several buys of one token share a balance, so check the total matches what the quotes promised.
  const promised = new Map<string, { symbol: string; amount: bigint; token: Address }>();
  for (const [i, v] of venues) {
    if (!results[i].ok) continue;
    const p = promised.get(v.token) ?? { symbol: v.symbol, amount: 0n, token: v.token };
    p.amount += quotes.get(i)!.out;
    promised.set(v.token, p);
  }
  for (const p of promised.values()) if (!wholeRevert && delta(plan.wallet, p.token) < p.amount) warnings.push(`${p.symbol}: the wallet would get ${fmt(delta(plan.wallet, p.token), 18)}, less than the ${fmt(p.amount, 18)} quoted`);

  const leftovers = built.readBacks
    .filter((rb) => rb.reads!.holder.toLowerCase() === MULTICALL3.toLowerCase())
    .map((rb) => ({ symbol: rb.reads!.symbol, amount: afterOf.get(`${rb.reads!.holder}|${rb.reads!.asset}`.toLowerCase()) ?? 0n }))
    .filter((l) => l.amount > 0n && !wholeRevert);

  // 5. Gas: the batch vs the same actions one transaction at a time.
  const generous = mergeOverrides(usdcMirror, { [plan.wallet]: { balance: toHex(PLENTY) } });
  const gas = wholeRevert ? null : await chain.estimateGas({ from: plan.wallet, to: MULTICALL3, value: built.value, data: sentData(built) }, generous);
  const price = await chain.gasPrice();
  const single = await oneByOne(chain, plan, venues, quotes);

  for (const r of results) if (!r.ok) refusals.push(`action ${r.action + 1} (${r.label}) would fail: ${r.reason}`);
  if (leftovers.length) refusals.push(`Multicall3 would keep ${leftovers.map((l) => `${l.symbol} ${l.amount}`).join(", ")}, where anyone could take it`);
  if (gas !== null && gas > GAS_CAP) refusals.push(`the batch needs ${gas} gas, over the ${GAS_CAP} onego allows in one transaction; split the plan`);
  if (built.value + (gas ?? 0n) * price > pros) refusals.push(`not enough PROS: the wallet has ${fmt(pros, 18)}, the batch needs ${fmt(built.value, 18)} plus about ${fmt((gas ?? 0n) * price, 18)} for gas`);
  if (usesUsdc && usdc < built.authorizations.reduce((s, a) => s + a.value, 0n)) refusals.push(`not enough USDC: the wallet has ${fmt(usdc, USDC_DECIMALS)}, the payments add up to ${fmt(built.authorizations.reduce((s, a) => s + a.value, 0n), USDC_DECIMALS)}`);

  return {
    wallet: plan.wallet,
    results,
    leftovers,
    batch: { txs: 1, gas, feePros: gas === null ? null : gas * price, value: built.value },
    oneByOne: { txs: single.txs, gas: single.gas, feePros: single.gas * price },
    warnings,
    sendable: refusals.length === 0,
    refusals,
    built: { ...built, overrides },
  };
}

async function readUnits(chain: Chain, token: Address, holder: Address): Promise<bigint> {
  const r = await chain.call({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [holder] }) });
  if (!r.ok) throw new Error(`couldn't read the balance of ${holder}: ${r.message}`);
  return BigInt(r.data);
}

export function fmt(units: bigint, decimals: number, maxFrac = 6): string {
  const neg = units < 0n;
  const u = neg ? -units : units;
  const whole = u / 10n ** BigInt(decimals);
  const frac = (u % 10n ** BigInt(decimals)).toString().padStart(decimals, "0").slice(0, maxFrac).replace(/0+$/, "");
  return `${neg ? "-" : ""}${whole.toLocaleString("en-US")}${frac ? `.${frac}` : ""}`;
}
