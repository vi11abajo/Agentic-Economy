// What someone holds in one market and what it would fetch if sold on the curve right now.
import { erc20Abi, parseAbi, type Address } from "viem";
import { client } from "./chain.js";
import { checkMarket } from "./market.js";

const sellAbi = parseAbi([
  "function quoteSell(uint256) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
]);

export interface Position {
  owner: Address;
  market: Address;
  block: bigint;
  genuine: boolean;
  phase: number;
  balance: bigint;
  /** Net PROS out of a full sell on the curve; null once the market graduated (sell happens on the DEX then). */
  sellNetPros: bigint | null;
}

export async function readPosition(owner: Address, market: Address): Promise<Position> {
  const m = await checkMarket(market, 0n);
  const base = { owner, market: m.market, block: m.block, genuine: m.genuine, phase: m.phase };
  if (!m.genuine || !m.pToken) return { ...base, balance: 0n, sellNetPros: null };
  const balance = await client.readContract({ address: m.pToken, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: m.block });
  let sellNetPros: bigint | null = null;
  if (m.phase === 0 && balance > 0n) {
    const q = await client.readContract({ address: market, abi: sellAbi, functionName: "quoteSell", args: [balance], blockNumber: m.block });
    sellNetPros = q[2];
  }
  return { ...base, balance, sellNetPros };
}
