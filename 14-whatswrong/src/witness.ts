// Everything whatswrong asks the chain goes through one "witness". The real one talks to Pharos Chain MCP (tx,
// receipt, replays, blocks) and to rpc.pharos.xyz only for what the MCP can't do yet: call traces and state
// overrides. A tape wrapper records every answer, so tests can replay a real investigation without a network.
import type { CallFrame } from "./clues.js";
import type { PharosMcp } from "./mcp.js";

export interface Tx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  gas: string;
  blockNumber: string;
  transactionIndex: string;
}

export interface Receipt {
  status: string;
  gasUsed: string;
  blockNumber: string;
}

export interface CallSpec {
  from: string;
  to: string;
  data: string;
  value?: string;
  gas?: string;
}

/** What a replay came back with: either the return bytes, or the revert bytes and the node's message. */
export type Echo = { reverted: false; returned: string } | { reverted: true; revertData: string; message: string };

export interface LogLine {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  transactionHash: string;
}

export interface ChainBlock {
  number: number;
  timestamp: number;
  transactions: Array<{ hash: string; from: string; to: string | null; input: string; transactionIndex: string }>;
}

/** address -> storage slot -> value, the shape eth_call's third parameter wants. */
export type StateTweaks = Record<string, { stateDiff: Record<string, string> }>;

export interface Witness {
  transaction(hash: string): Promise<Tx | null>;
  receipt(hash: string): Promise<Receipt | null>;
  replay(call: CallSpec, block: number | "latest"): Promise<Echo>;
  /** Same as replay, but with storage patched first (used to prove "with an approve it would have worked"). */
  replayPatched(call: CallSpec, tweaks: StateTweaks, block?: number | "latest"): Promise<Echo>;
  estimateGas(call: CallSpec): Promise<bigint | null>;
  trace(hash: string): Promise<CallFrame | null>;
  block(number: number | "latest"): Promise<ChainBlock>;
  /** Human name of a 4-byte selector from the public signature database, or null. */
  nameOf(selector: string, kind: "function" | "error"): Promise<string | null>;
  /** Event logs through Chain MCP; the window must stay within 1000 blocks. */
  logs(filter: { address: string; topics: Array<string | null>; fromBlock: number; toBlock: number }): Promise<LogLine[]>;
}

const hex = (n: number) => `0x${n.toString(16)}`;
const RPC = process.env.WHATSWRONG_RPC || "https://rpc.pharos.xyz";
const SIGNATURES = "https://api.4byte.sourcify.dev/signature-database/v1/lookup";

type McpRevert = { error?: { message?: string; data?: string } };

/**
 * Only the EVM saying no counts as a revert: "execution reverted" (code 3), or the node refusing for lack of funds.
 * Anything else (missing state, rate limits, a sick node) is a problem with asking, not an answer, so it throws.
 */
/** The node itself couldn't answer (as opposed to the EVM saying no). */
export class NodeTrouble extends Error {}

const soundsLikeTheChainSaidNo = (message = "", code?: number) => code === 3 || /revert|enough funds|insufficient funds/i.test(message);

function echoFromMcpError(err: unknown): Echo {
  // The MCP client throws on isError; its body is the node's JSON error with the revert bytes in `data`.
  const body = String((err as { body?: string }).body ?? (err as Error).message ?? "");
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; data?: string; code?: number } };
    if (parsed.error && soundsLikeTheChainSaidNo(parsed.error.message, parsed.error.code)) return { reverted: true, revertData: parsed.error.data ?? "0x", message: parsed.error.message ?? "" };
  } catch {
    /* not JSON: it wasn't the EVM talking */
  }
  throw err;
}

type RpcAnswer<T> = { result?: T; error?: { message: string; data?: string; code?: number } };

async function rawRpc<T>(method: string, params: unknown[]): Promise<RpcAnswer<T>> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, 1500 * attempt));
      continue;
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as RpcAnswer<T>;
    } catch {
      throw new Error(`${RPC} answered ${method} with HTTP ${res.status} and no JSON`);
    }
  }
}

const asRpcCall = (c: CallSpec) => ({ from: c.from, to: c.to, data: c.data, value: c.value, gas: c.gas });

export function onChainWitness(mcp: PharosMcp): Witness {
  return {
    transaction: (hash) => mcp.call<Tx | null>("get_transaction", { hash }),
    receipt: (hash) => mcp.call<Receipt | null>("get_transaction_receipt", { hash }),
    replay: async (call, block) => {
      try {
        const answer = await mcp.call<{ result?: string } & McpRevert>("eth_call", { transaction: asRpcCall(call), block: block === "latest" ? "latest" : block });
        if (answer.error) {
          if (!soundsLikeTheChainSaidNo(answer.error.message)) throw new NodeTrouble(`the node couldn't run eth_call: ${answer.error.message}`);
          return { reverted: true, revertData: answer.error.data ?? "0x", message: answer.error.message ?? "" };
        }
        return { reverted: false, returned: answer.result ?? "0x" };
      } catch (err) {
        if (err instanceof NodeTrouble) throw err;
        return echoFromMcpError(err);
      }
    },
    replayPatched: async (call, tweaks, block = "latest") => {
      const answer = await rawRpc<string>("eth_call", [asRpcCall(call), block === "latest" ? block : hex(block), tweaks]);
      if (answer.error) {
        if (!soundsLikeTheChainSaidNo(answer.error.message, answer.error.code)) throw new NodeTrouble(`the node couldn't run the patched eth_call: ${answer.error.message}`);
        return { reverted: true, revertData: answer.error.data ?? "0x", message: answer.error.message };
      }
      return { reverted: false, returned: answer.result ?? "0x" };
    },
    estimateGas: async (call) => {
      try {
        const answer = await mcp.call<{ gas?: string; result?: string } | string>("estimate_gas", { transaction: { from: call.from, to: call.to, data: call.data, value: call.value } });
        const raw = typeof answer === "string" ? answer : (answer.gas ?? answer.result);
        return raw ? BigInt(raw) : null;
      } catch {
        return null; // it reverts no matter how much gas you give it
      }
    },
    // The trace is a bonus: if the endpoint is down or slow, the diagnosis goes on with the MCP replay alone.
    trace: async (hash) => (await rawRpc<CallFrame>("debug_traceTransaction", [hash, { tracer: "callTracer" }]).catch(() => ({}) as RpcAnswer<CallFrame>)).result ?? null,
    block: async (number) => {
      const b = await mcp.call<{ number: string; timestamp: string; transactions: ChainBlock["transactions"] }>("get_block", { block: number === "latest" ? "latest" : hex(number), includeTransactions: true });
      return { number: Number(BigInt(b.number)), timestamp: Number(BigInt(b.timestamp)), transactions: b.transactions };
    },
    logs: async ({ address, topics, fromBlock, toBlock }) =>
      mcp.call<LogLine[]>("get_logs", { address, topics, fromBlock: hex(fromBlock), toBlock: hex(toBlock) }),
    nameOf: async (selector, kind) => {
      try {
        const res = await fetch(`${SIGNATURES}?${kind}=${selector}&filter=true`, { signal: AbortSignal.timeout(8000) });
        const body = (await res.json()) as { result?: Record<string, Record<string, Array<{ name: string }> | null>> };
        return body.result?.[kind]?.[selector]?.[0]?.name ?? null;
      } catch {
        return null; // the lookup is a nice-to-have, never a reason to fail the diagnosis
      }
    },
  };
}

export type Tape = Record<string, unknown>;
const keyOf = (method: string, args: unknown[]) => `${method} ${JSON.stringify(args)}`;

/** Wraps a witness and writes down every question and answer, so the same investigation can be replayed offline. */
export function taped(real: Witness, tape: Tape): Witness {
  const wrap =
    <A extends unknown[], R>(method: keyof Witness, fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      const answer = await fn(...args);
      tape[keyOf(method, args)] = answer === undefined ? null : JSON.parse(JSON.stringify(answer, (_, v) => (typeof v === "bigint" ? `${v}n` : v)));
      return answer;
    };
  const out = {} as Witness;
  for (const m of Object.keys(real) as Array<keyof Witness>) (out as unknown as Record<string, unknown>)[m] = wrap(m, (real[m] as (...a: unknown[]) => Promise<unknown>).bind(real));
  return out;
}

/** A witness that only knows what's on the tape; asking anything else is a test bug, so it says so loudly. */
export function fromTape(tape: Tape): Witness {
  const revive = (v: unknown) => JSON.parse(JSON.stringify(v), (_, x) => (typeof x === "string" && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
  const ask = (method: string) => async (...args: unknown[]) => {
    const key = keyOf(method, args);
    if (!(key in tape)) throw new Error(`not on the tape: ${key.slice(0, 160)}`);
    return revive(tape[key]);
  };
  return { transaction: ask("transaction"), receipt: ask("receipt"), replay: ask("replay"), replayPatched: ask("replayPatched"), estimateGas: ask("estimateGas"), trace: ask("trace"), block: ask("block"), nameOf: ask("nameOf"), logs: ask("logs") } as Witness;
}
