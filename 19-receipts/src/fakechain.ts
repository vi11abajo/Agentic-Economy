// A tiny pretend Pharos for tests: contracts are plain objects of read functions. Both direct eth_calls and
// Multicall3 batches are answered from them, so adapter code runs exactly as it does against the real chain.
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionResult, type Hex } from "viem";
import { READS } from "./abis.js";
import { ScriptedLine } from "./fakes.js";
import { MULTICALL3 } from "./chain.js";
import { ToolSaidNo } from "./mcp.js";

export type FakeContract = Record<string, (...args: any[]) => unknown>;

const MC_SELECTOR = "0x82ad56cb"; // aggregate3

export function fakeChain(contracts: Record<string, FakeContract>, extra: Record<string, string | ((a: Record<string, unknown>) => string)> = {}): ScriptedLine & { blocks: string[] } {
  const lower = new Map(Object.entries(contracts).map(([a, c]) => [a.toLowerCase(), c]));
  const blocks: string[] = [];

  const answer = (to: string, data: Hex): Hex => {
    const contract = lower.get(to.toLowerCase());
    if (!contract) throw new Error("no code");
    const { functionName, args } = decodeFunctionData({ abi: READS, data });
    const fn = contract[functionName];
    if (!fn) throw new Error(`${to} has no ${functionName}`);
    const value = fn(...((args ?? []) as unknown as unknown[]));
    return encodeFunctionResult({ abi: READS, functionName, result: value as never });
  };

  const line = new ScriptedLine({
    eth_call: (a) => {
      const tx = a.transaction as { to: string; data: Hex };
      blocks.push(String(a.block));
      if (tx.to.toLowerCase() === MULTICALL3.toLowerCase() && tx.data.startsWith(MC_SELECTOR)) {
        const [calls] = decodeAbiParameters([{ type: "tuple[]", components: [{ type: "address" }, { type: "bool" }, { type: "bytes" }] }], `0x${tx.data.slice(10)}`);
        const results = (calls as readonly (readonly [string, boolean, Hex])[]).map(([target, , callData]) => {
          try {
            return [true, answer(target, callData)] as const;
          } catch {
            return [false, "0x"] as const;
          }
        });
        return JSON.stringify({ result: encodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], [results as never]) });
      }
      try {
        return JSON.stringify({ result: answer(tx.to, tx.data) });
      } catch (err) {
        throw new ToolSaidNo("eth_call", `execution reverted: ${(err as Error).message}`);
      }
    },
    get_block_number: JSON.stringify({ blockNumber: "1002" }),
    get_code: (a) => JSON.stringify({ code: lower.has(String(a.address).toLowerCase()) ? "0x6080" : "0x" }),
    ...extra,
  });
  return Object.assign(line, { blocks });
}
