// A thin "ask the contract" helper on top of chain.ts: encode with viem, call, decode, and when it fails say
// which question failed, not just "execution reverted".
import { decodeFunctionResult, encodeFunctionData, type Abi, type Hex } from "viem";
import type { Chain, Overrides } from "./chain.js";

export type At = number | "latest";

export class ReadFailed extends Error {}

export async function ask<T>(chain: Chain, what: string, to: Hex, abi: Abi, fn: string, args: readonly unknown[], at: At = "latest", ov?: Overrides): Promise<T> {
  const data = encodeFunctionData({ abi, functionName: fn, args } as never);
  const r = await chain.call({ to, data }, at, ov);
  if (!r.ok) throw new ReadFailed(`${what}: ${r.message}`);
  if (r.data === "0x") throw new ReadFailed(`${what}: empty answer (no contract there at this block?)`);
  return decodeFunctionResult({ abi, functionName: fn, data: r.data } as never) as T;
}

/** Same, but a failure is an answer (null) rather than an error: for "is this a Safe?" kinds of probing. */
export async function maybe<T>(chain: Chain, to: Hex, abi: Abi, fn: string, args: readonly unknown[] = [], at: At = "latest"): Promise<T | null> {
  try {
    return await ask<T>(chain, fn, to, abi, fn, args, at);
  } catch {
    return null;
  }
}

const symbols = new Map<string, { symbol: string; decimals: number }>();

export async function tokenInfo(chain: Chain, token: Hex): Promise<{ symbol: string; decimals: number }> {
  const k = token.toLowerCase();
  const known = symbols.get(k);
  if (known) return known;
  const { erc20 } = await import("./abis.js");
  const [symbol, decimals] = await Promise.all([
    maybe<string>(chain, token, erc20, "symbol"),
    ask<number>(chain, `decimals of ${token}`, token, erc20, "decimals", []),
  ]);
  const info = { symbol: symbol ?? `${token.slice(0, 6)}…`, decimals: Number(decimals) };
  symbols.set(k, info);
  return info;
}

export const RAY = 10n ** 27n;
/** Aave and Morpho both quote per-second or per-year rates in fixed point; this turns a ray APR into a number. */
export const rayToApr = (r: bigint) => Number((r * 10n ** 9n) / RAY) / 1e9;
