// The send-or-not decision, kept apart from the simulation so each rule can be pinned by a test.
import type { Address } from "viem";
import type { Step } from "./batch.js";
import { MULTICALL3, USDC_DECIMALS } from "./book.js";
import type { ActionResult } from "./check.js";
import { fmt } from "./format.js";

export const GAS_CAP = 30_000_000n; // far below the 1e9 block limit; a batch is never split, so it must fit

/** What the batch itself would leave in Multicall3: the change in each balance, not what was parked there before. */
export function multicallKeeps(readBacks: Step[], before: Map<string, bigint>, after: Map<string, bigint>): Array<{ symbol: string; amount: bigint }> {
  return readBacks
    .filter((rb) => rb.reads!.holder.toLowerCase() === MULTICALL3.toLowerCase())
    .map((rb) => {
      const key = `${rb.reads!.holder}|${rb.reads!.asset}`.toLowerCase();
      return { symbol: rb.reads!.symbol, amount: (after.get(key) ?? 0n) - (before.get(key) ?? 0n) };
    })
    .filter((k) => k.amount > 0n);
}

export type Gate = {
  results: ActionResult[];
  wholeRevert: boolean;
  keeps: Array<{ symbol: string; amount: bigint }>;
  gas: bigint | null;
  price: bigint;
  pros: bigint;
  value: bigint;
  usesUsdc: boolean;
  usdc: bigint;
  usdcNeeded: bigint;
  shortfalls: Array<{ symbol: string; got: bigint; promised: bigint }>;
  contractRecipients: Address[];
};

export function gatekeep(g: Gate): string[] {
  const no: string[] = [];
  for (const r of g.results) if (!r.ok) no.push(`action ${r.action + 1} (${r.label}) would fail: ${r.reason}`);
  // A contract may book the PROS for whoever called it, and inside the batch that's Multicall3, not the sender.
  for (const a of g.contractRecipients) no.push(`${a} is a contract: PROS sent to it from the batch could end up credited to Multicall3, where anyone could take it. Send PROS to plain wallets only`);
  if (g.keeps.length) no.push(`Multicall3 would keep ${g.keeps.map((k) => `${fmt(k.amount, 18)} ${k.symbol}`).join(", ")}, where anyone could take it`);
  for (const s of g.shortfalls) no.push(`${s.symbol}: the wallet would get ${fmt(s.got, 18)}, less than the ${fmt(s.promised, 18)} quoted`);
  if (g.gas === null && !g.wholeRevert) no.push("the node couldn't estimate gas for the batch, so it's not safe to send");
  if (g.gas !== null && g.gas > GAS_CAP) no.push(`the batch needs ${g.gas} gas, over the ${GAS_CAP} onego allows in one transaction; split the plan`);
  if (g.value + (g.gas ?? 0n) * g.price > g.pros) no.push(`not enough PROS: the wallet has ${fmt(g.pros, 18)}, the batch needs ${fmt(g.value, 18)} plus about ${fmt((g.gas ?? 0n) * g.price, 18)} for gas`);
  if (g.usesUsdc && g.usdc < g.usdcNeeded) no.push(`not enough USDC: the wallet has ${fmt(g.usdc, USDC_DECIMALS)}, the payments add up to ${fmt(g.usdcNeeded, USDC_DECIMALS)}`);
  return no;
}
