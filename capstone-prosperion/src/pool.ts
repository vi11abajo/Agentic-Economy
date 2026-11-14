// After graduation a pToken leaves the curve for a FaroSwap pair (the market's externalPair()), paired with WPROS.
// This reads that pair at one block: how much PROS and how many tokens sit in it, and the price that implies.
// A spot price only: a real sell moves it, more so in a thin pool, and the pool's fee is not read here.
import { formatEther, getAddress, parseAbi, type Address } from "viem";
import { client } from "./chain.js";

export const WPROS = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0" as Address;
const marketAbi = parseAbi(["function externalPair() view returns (address)", "function pToken() view returns (address)", "function phase() view returns (uint8)"]);
const pairAbi = parseAbi([
  "function token0() view returns (address)", "function token1() view returns (address)",
  "function getReserves() view returns (uint112, uint112, uint32)", "function factory() view returns (address)",
]);

/** Pure: which side is PROS, and the price per million tokens (pTokens are priced in tiny fractions of a PROS). */
export function poolFrom(token0: string, token1: string, r0: bigint, r1: bigint, pToken: string) {
  const w = WPROS.toLowerCase(), t = pToken.toLowerCase();
  const [pros, tokens] = token0.toLowerCase() === w && token1.toLowerCase() === t ? [r0, r1]
    : token1.toLowerCase() === w && token0.toLowerCase() === t ? [r1, r0] : [null, null];
  if (pros === null || tokens === null) throw new Error(`pair is not paired with WPROS and this pToken (${token0} / ${token1})`);
  const perMillion = tokens === 0n ? 0n : (pros * 10n ** 6n * 10n ** 4n) / tokens;
  return {
    prosInPool: formatEther(pros),
    tokensInPool: formatEther(tokens),
    prosPerMillionTokens: (Number(perMillion) / 1e4).toString(),
  };
}

export async function readPool(market: Address) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const at = { blockNumber: block } as const;
  const [phase, pair, pToken] = await Promise.all([
    client.readContract({ address: market, abi: marketAbi, functionName: "phase", ...at }),
    client.readContract({ address: market, abi: marketAbi, functionName: "externalPair", ...at }),
    client.readContract({ address: market, abi: marketAbi, functionName: "pToken", ...at }),
  ]);
  if (Number(phase) !== 2) return { market, block, phase: Number(phase), pool: null, note: "Not graduated: it trades on the curve. Use market_check for the curve." };
  const [t0, t1, res, factory] = await Promise.all([
    client.readContract({ address: pair, abi: pairAbi, functionName: "token0", ...at }),
    client.readContract({ address: pair, abi: pairAbi, functionName: "token1", ...at }),
    client.readContract({ address: pair, abi: pairAbi, functionName: "getReserves", ...at }),
    client.readContract({ address: pair, abi: pairAbi, functionName: "factory", ...at }),
  ]);
  return {
    market, block, phase: 2, pair: getAddress(pair), pairFactory: factory, pToken,
    pool: poolFrom(t0, t1, res[0], res[1], pToken),
    lastPoolUpdate: new Date(Number(res[2]) * 1000).toISOString(),
    note: "Spot price from the pair's reserves at this block. A sell moves it; the bigger the sell against prosInPool, the worse the fill.",
  };
}
