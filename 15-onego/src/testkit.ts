// Helpers shared by the tests and the tape recorder. Not part of the CLI.
import { encodeFunctionData, toHex, type Address } from "viem";
import type { CallResult, Chain } from "./chain.js";
import { MULTICALL3, WPROS, erc20Abi, multicall3Abi, pairAbi, wprosAbi } from "./book.js";
import type { Venue } from "./market.js";

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
