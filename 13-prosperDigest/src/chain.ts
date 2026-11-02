// What prosperDigest reads from Pharos, behind one small interface so tests can run on a fake chain. The real one
// goes through Pharos Chain MCP (mcp.pharos.xyz), paced by the MCP client to stay under its rate limit.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";
import type { PharosMcp } from "./mcp.js";
import { BOUGHT, MARKET_CREATED, PHASE_SELECTOR, SOLD, type RpcLog } from "./prosper.js";

export interface Chain {
  head(): Promise<number>;
  blockTime(n: number): Promise<number>;
  /** Every MarketCreated / Bought / Sold log in [from, to] (at most 1000 blocks), any address, in chain order. */
  logs(from: number, to: number): Promise<RpcLog[]>;
  /** phase() of a market at a block; null when the market did not exist yet. */
  phase(market: string, block: number): Promise<number | null>;
  token(addr: string): Promise<{ symbol: string; decimals: number }>;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const viewAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

export function mcpChain(mcp: PharosMcp): Chain {
  const call = async (to: string, data: string, block: number | "latest") =>
    (await mcp.call<{ result: Hex }>("eth_call", { transaction: { to, data }, block: block === "latest" ? block : hex(block) })).result;
  return {
    head: async () => Number((await mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber),
    blockTime: async (n) => Number((await mcp.call<{ timestamp: string }>("get_block", { block: hex(n) })).timestamp),
    logs: async (from, to) => {
      // No address filter: one call per window whatever the number of markets; the caller keeps Prosper's own.
      const logs = await mcp.call<RpcLog[]>("get_logs", { topics: [[MARKET_CREATED, BOUGHT, SOLD]], fromBlock: hex(from), toBlock: hex(to) });
      return logs
        .filter((l) => !l.removed)
        .sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    },
    phase: async (market, block) => {
      const r = await call(market, PHASE_SELECTOR, block);
      return r === "0x" ? null : Number(BigInt(r));
    },
    token: async (addr) => {
      const symbol = decodeFunctionResult({ abi: viewAbi, functionName: "symbol", data: await call(addr, encodeFunctionData({ abi: viewAbi, functionName: "symbol" }), "latest") });
      const decimals = decodeFunctionResult({ abi: viewAbi, functionName: "decimals", data: await call(addr, encodeFunctionData({ abi: viewAbi, functionName: "decimals" }), "latest") });
      return { symbol: String(symbol), decimals: Number(decimals) };
    },
  };
}

/** First block whose timestamp is >= `t` (binary search; blocks are ~1 s apart, so a guess narrows it first). */
export async function blockAtTime(chain: Chain, t: number, head: number): Promise<number> {
  const headTime = await chain.blockTime(head);
  if (t > headTime) throw new Error(`time ${t} is after the chain head`);
  let lo = 0, hi = head;
  const guess = Math.max(0, Math.min(head, head - (headTime - t)));
  // Bracket around the 1 block/s guess, widening until it holds, before bisecting.
  for (let w = 64; w < head * 2; w *= 4) {
    const a = Math.max(0, guess - w), b = Math.min(head, guess + w);
    const ta = await chain.blockTime(a), tb = await chain.blockTime(b);
    if ((a === 0 || ta < t) && tb >= t) {
      lo = a;
      hi = b;
      if (ta >= t) return a;
      break;
    }
  }
  // Invariant: time(lo) < t <= time(hi).
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await chain.blockTime(mid)) >= t) hi = mid;
    else lo = mid;
  }
  return hi;
}
