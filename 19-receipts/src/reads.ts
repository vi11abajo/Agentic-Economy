// Batched reads at the scan's block, decoded with the shared ABI list.
import { encodeFunctionData, decodeFunctionResult, type Hex } from "viem";
import { READS, type ReadName } from "./abis.js";
import { multicall } from "./chain.js";
import type { ToolLine } from "./mcp.js";

export type Call = { to: string; fn: ReadName; args?: readonly unknown[] };

/** Runs a batch of reads through Multicall3 and decodes each answer; a failed read is undefined, never zero. */
export async function batch(ctx: { line: ToolLine; block: number }, calls: Call[]): Promise<unknown[]> {
  if (!calls.length) return [];
  const encoded = calls.map((c) => ({ to: c.to, data: encodeFunctionData({ abi: READS, functionName: c.fn as never, args: (c.args ?? []) as never }) }));
  const raw = await multicall(ctx.line, encoded, ctx.block);
  return raw.map((r, i) => {
    if (!r.ok) return undefined;
    try {
      return decodeFunctionResult({ abi: READS, functionName: calls[i].fn as never, data: r.data as Hex });
    } catch {
      return undefined;
    }
  });
}

