// Helpers shared by the tests and the tape recorder. Not part of the CLI.
import { encodeFunctionData, toHex, type Address } from "viem";
import type { CallResult, Chain } from "./chain.js";
import { MULTICALL3, WPROS, erc20Abi, multicall3Abi, pairAbi, wprosAbi } from "./book.js";
import type { Venue } from "./market.js";
import type { Plan } from "./plan.js";

export const PROBE_SENDER: Address = "0x000000000000000000000000000000000000bEEF";

/** Asks the real pair whether it would hand over `out` for `prosIn`: wrap, pay the pool, swap, all in one go. */
export function probeSwap(chain: Chain, v: Extract<Venue, { kind: "pool" }>, prosIn: bigint, out: bigint): Promise<CallResult> {
  const swapArgs = v.wprosIs0 ? [0n, out, PROBE_SENDER, "0x"] : [out, 0n, PROBE_SENDER, "0x"];
  const calls = [
    { target: WPROS, allowFailure: false, value: prosIn, callData: encodeFunctionData({ abi: wprosAbi, functionName: "deposit" }) },
    { target: WPROS, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [v.pair, prosIn] }) },
    { target: v.pair, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: pairAbi, functionName: "swap", args: swapArgs as [bigint, bigint, Address, `0x${string}`] }) },
  ];
  return chain.call(
    { from: PROBE_SENDER, to: MULTICALL3, value: prosIn, data: encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [calls] }) },
    { [PROBE_SENDER]: { balance: toHex(prosIn * 2n) } },
  );
}

// A fixed throwaway key and nonces, so a recorded check asks the tape exactly the same questions on replay.
export const SIM_KEY = "0xc75108770a52b5da3ffaca2d948b51f90e0ca62b57aa26fe47ed3f59fc930b92" as const;
export const nonceFor = (i: number): `0x${string}` => `0x${(i + 1).toString(16).padStart(64, "0")}`;

type Saved = { plan: Plan; now: string; whatIf?: { pros?: string; usdc?: string } };
const big = (s?: string) => (s === undefined ? undefined : BigInt(s.replace(/n$/, "")));
export function revivePlan(saved: Saved): { plan: Plan; now: bigint; whatIf?: { pros?: bigint; usdc?: bigint } } {
  return { plan: saved.plan, now: big(saved.now)!, whatIf: saved.whatIf && { pros: big(saved.whatIf.pros), usdc: big(saved.whatIf.usdc) } };
}
