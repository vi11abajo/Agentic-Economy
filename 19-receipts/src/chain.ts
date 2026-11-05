// Everything receipts knows for sure comes through here: reads at one pinned block, and transaction receipts.
import { decodeAbiParameters, encodeFunctionData, hexToString, parseAbi, parseUnits, type Hex } from "viem";
import { ToolSaidNo, type ToolLine } from "./mcp.js";
import { readJson, writeJson } from "./home.js";
import type { ExplorerTransfer } from "./explorer.js";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
export const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
export const ZERO = "0x0000000000000000000000000000000000000000";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const WRAP = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"; // WPROS Deposit(dst, wad)
const UNWRAP = "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65"; // WPROS Withdrawal(src, wad)

const mcAbi = parseAbi([
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)",
]);
const metaAbi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);

async function json<T>(line: ToolLine, tool: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await line.ask(tool, args)) as T;
}

/** Two blocks behind the head: the hosted MCP sits behind a load balancer and the newest block isn't everywhere yet. */
export async function pinBlock(line: ToolLine): Promise<number> {
  const { blockNumber } = await json<{ blockNumber: string }>(line, "get_block_number", {});
  return Number(blockNumber) - 2;
}

/** Plain eth_call at a block. Throws ToolSaidNo on a revert; callers decide what a revert means. */
export async function callAt(line: ToolLine, to: string, data: Hex, block: number): Promise<Hex> {
  const { result } = await json<{ result: Hex }>(line, "eth_call", { transaction: { to, data }, block: String(block) });
  if (!result || result === "0x") throw new ToolSaidNo("eth_call", `empty answer from ${to} at block ${block} (no code there?)`);
  return result;
}

export type CallOutcome = { ok: true; data: Hex } | { ok: false };

/** Many reads in one eth_call through Multicall3. A call that fails stays a failure, it never turns into a zero. */
export async function multicall(line: ToolLine, calls: { to: string; data: Hex }[], block: number): Promise<CallOutcome[]> {
  const out: CallOutcome[] = [];
  for (let i = 0; i < calls.length; i += 150) {
    const chunk = calls.slice(i, i + 150);
    const data = encodeFunctionData({
      abi: mcAbi,
      functionName: "aggregate3",
      args: [chunk.map((c) => ({ target: c.to as Hex, allowFailure: true, callData: c.data }))],
    });
    const raw = await callAt(line, MULTICALL3, data, block);
    const [results] = decodeAbiParameters([{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }], raw);
    for (const [success, returnData] of results as readonly (readonly [boolean, Hex])[]) {
      out.push(success && returnData !== "0x" ? { ok: true, data: returnData } : { ok: false });
    }
  }
  return out;
}

export async function nativeBalance(line: ToolLine, wallet: string, block: number): Promise<bigint> {
  const { balanceWei } = await json<{ balanceWei: string }>(line, "get_balance", { address: wallet, block: String(block) });
  return BigInt(balanceWei);
}

export interface TokenMeta {
  symbol: string;
  decimals: number;
  /** "chain" when symbol() and decimals() answered, "explorer" when we had to take the explorer's word. */
  from: "chain" | "explorer";
}

/** symbol() and decimals() for many tokens in one go; the explorer's token_info is the fallback. */
export async function tokenMeta(line: ToolLine, tokens: string[], block: number, fallback: Map<string, { symbol?: string; decimals?: number }>): Promise<Map<string, TokenMeta>> {
  const calls = tokens.flatMap((t) => [
    { to: t, data: encodeFunctionData({ abi: metaAbi, functionName: "symbol" }) },
    { to: t, data: encodeFunctionData({ abi: metaAbi, functionName: "decimals" }) },
  ]);
  const results = await multicall(line, calls, block);
  const meta = new Map<string, TokenMeta>();
  tokens.forEach((t, i) => {
    const sym = results[2 * i];
    const dec = results[2 * i + 1];
    const symbol = sym.ok ? readSymbol(sym.data) : undefined;
    const decimals = dec.ok ? Number(BigInt(dec.data)) : undefined;
    const fb = fallback.get(t.toLowerCase());
    if (symbol !== undefined && decimals !== undefined) meta.set(t.toLowerCase(), { symbol, decimals, from: "chain" });
    else meta.set(t.toLowerCase(), { symbol: symbol ?? fb?.symbol ?? t.slice(0, 8), decimals: decimals ?? fb?.decimals ?? 18, from: "explorer" });
  });
  return meta;
}

/** Some old tokens return symbol as bytes32 instead of a string; take whichever decodes. */
function readSymbol(data: Hex): string | undefined {
  try {
    return decodeAbiParameters([{ type: "string" }], data)[0];
  } catch {
    try {
      return hexToString(data.slice(0, 66) as Hex).replace(/\0+$/, "") || undefined;
    } catch {
      return undefined;
    }
  }
}

export interface Leg {
  token: string;
  from: string;
  to: string;
  amount: bigint;
  logIndex: number;
}

export interface TxReceipt {
  hash: string;
  block: number;
  status: 0 | 1;
  from: string;
  to: string | null;
  /** Native PROS the sender attached to the call. */
  nativeValue: bigint;
  transfers: Leg[];
  /** WPROS wrapped by someone in this tx (who, how much). */
  wraps: { who: string; amount: bigint }[];
  /** WPROS unwrapped back to native PROS (who, how much): how routers pay out native PROS. */
  unwraps: { who: string; amount: bigint }[];
}

const topicAddr = (t: string) => `0x${t.slice(26)}`.toLowerCase();

/**
 * The transaction and its receipt, boiled down to who sent what to whom. Receipts never change once mined, so
 * each one is read from the chain once and kept in the data home.
 */
export async function receiptTransfers(line: ToolLine, hash: string): Promise<TxReceipt> {
  const rel = `receipts/${hash.toLowerCase()}.json`;
  const cached = readJson<null | Record<string, unknown>>(rel, null);
  if (cached) return revive(cached);
  const tx = await json<{ from: string; to: string | null; value: string }>(line, "get_transaction", { hash });
  const rc = await json<{ blockNumber: string; status: string; logs: { address: string; topics: string[]; data: string; logIndex: string }[] }>(line, "get_transaction_receipt", { hash });
  const out: TxReceipt = {
    hash: hash.toLowerCase(),
    block: Number(rc.blockNumber),
    status: Number(rc.status) === 1 ? 1 : 0,
    from: tx.from.toLowerCase(),
    to: tx.to?.toLowerCase() ?? null,
    nativeValue: BigInt(tx.value ?? "0x0"),
    transfers: [],
    wraps: [],
    unwraps: [],
  };
  for (const log of rc.logs) {
    const address = log.address.toLowerCase();
    if (log.topics[0] === TRANSFER && log.topics.length === 3) {
      out.transfers.push({ token: address, from: topicAddr(log.topics[1]), to: topicAddr(log.topics[2]), amount: BigInt(log.data), logIndex: Number(log.logIndex) });
    } else if (address === WPROS && log.topics[0] === WRAP) {
      out.wraps.push({ who: topicAddr(log.topics[1]), amount: BigInt(log.data) });
    } else if (address === WPROS && log.topics[0] === UNWRAP) {
      out.unwraps.push({ who: topicAddr(log.topics[1]), amount: BigInt(log.data) });
    }
  }
  writeJson(rel, out);
  return out;
}

function revive(saved: Record<string, unknown>): TxReceipt {
  const r = saved as unknown as TxReceipt & { nativeValue: string };
  return {
    ...r,
    nativeValue: BigInt(r.nativeValue),
    transfers: r.transfers.map((t) => ({ ...t, amount: BigInt(t.amount as unknown as string) })),
    wraps: r.wraps.map((w) => ({ ...w, amount: BigInt(w.amount as unknown as string) })),
    unwraps: r.unwraps.map((w) => ({ ...w, amount: BigInt(w.amount as unknown as string) })),
  };
}

/** Does the explorer's row match the receipt's own log? If not, the chain's amount is the one we keep. */
export function confirmTransfer(row: Pick<ExplorerTransfer, "log_index" | "token_address" | "value" | "token_info">, receipt: TxReceipt): { ok: true } | { ok: false; chainAmount: bigint | null } {
  const leg = receipt.transfers.find((t) => t.logIndex === row.log_index && t.token === row.token_address.toLowerCase());
  if (!leg) return { ok: false, chainAmount: null };
  let claimed: bigint;
  try {
    claimed = parseUnits(row.value, row.token_info?.decimals ?? 18);
  } catch {
    return { ok: false, chainAmount: leg.amount };
  }
  // The explorer rounds long decimals; anything within a millionth of the amount is the same transfer.
  const diff = claimed > leg.amount ? claimed - leg.amount : leg.amount - claimed;
  return diff * 1_000_000n <= leg.amount ? { ok: true } : { ok: false, chainAmount: leg.amount };
}
