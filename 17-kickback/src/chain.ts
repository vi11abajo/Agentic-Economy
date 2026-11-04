// Everything kickback knows about the chain comes through here, and everything here comes from the Pharos
// Chain MCP. The same Chain can also be fed from a recorded tape, which is how the tests run without a network.
import type { Address, Hex } from "viem";
import type { PharosMcp } from "./mcp.js";

/** One Chain MCP call as the user sees it scroll by: which step asked, which tool, a short look at the args. */
export type CallLog = { step: string; tool: string; args: string; ms: number };

export type RpcLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: bigint; logIndex: number; transactionHash: Hex };
export type Receipt = { status: "success" | "reverted"; blockNumber: bigint; from: Address; to: Address | null; logs: RpcLog[] };
export type TxInfo = { hash: Hex; from: Address; to: Address | null; value: bigint; input: Hex; blockNumber: bigint | null };
export type TxDraft = { from: Address; to: Address; data?: Hex; value?: bigint };
export type LogQuery = { address: Address[] | Address; topics: (Hex | Hex[] | null)[]; from: bigint; to: bigint };

export interface Chain {
  blockNumber(): Promise<bigint>;
  call(to: Address, data: Hex, block?: bigint): Promise<Hex>;
  logs(q: LogQuery): Promise<RpcLog[]>;
  code(a: Address): Promise<Hex>;
  balance(a: Address): Promise<bigint>;
  block(n: bigint): Promise<{ number: bigint; hash: Hex } | null>;
  nonce(a: Address): Promise<number>;
  gasPrice(): Promise<bigint>;
  estimateGas(tx: TxDraft): Promise<bigint>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(h: Hex): Promise<Receipt | null>;
  transaction(h: Hex): Promise<TxInfo | null>;
  /** Names the step the next calls belong to, for the live printout and the journal. */
  step(name: string): void;
  journal: CallLog[];
}

/** eth_call / estimate_gas came back with an EVM revert (the MCP answers `{error}` instead of failing the tool). */
export class RevertedCall extends Error {
  constructor(message: string, readonly data?: Hex) {
    super(message);
  }
}

export type Tape = Record<string, unknown>;
type Ask = (tool: string, args: Record<string, unknown>) => Promise<unknown>;

const hex = (n: bigint | number) => `0x${n.toString(16)}`;
const lower = <T extends string>(s: T) => s.toLowerCase() as T;

/** The chain over the real Chain MCP. `onCall` is the live printout. */
export function mcpChain(mcp: PharosMcp, onCall?: (c: CallLog) => void): Chain {
  return chainOver((tool, args) => mcp.call(tool, args), onCall);
}

/** The chain over a recorded tape: the exact args are the key, so a test fails loudly if a call changes. */
export function tapeChain(tape: Tape): Chain {
  return chainOver(async (tool, args) => {
    const key = `${tool} ${JSON.stringify(args)}`;
    if (!(key in tape)) throw new Error(`no tape for ${key}`);
    return tape[key];
  });
}

/** Wraps another chain's raw answers into a tape while it runs (test/record.mjs). */
export function recordingAsk(ask: Ask, tape: Tape): Ask {
  return async (tool, args) => {
    const answer = await ask(tool, args);
    tape[`${tool} ${JSON.stringify(args)}`] = answer;
    return answer;
  };
}

export function chainOver(ask: Ask, onCall?: (c: CallLog) => void): Chain {
  let current = "start";
  const journal: CallLog[] = [];

  // Every call goes through here once, so the journal is the true order of what was asked.
  async function asked<T>(tool: string, args: Record<string, unknown>, glimpse: string): Promise<T> {
    const started = Date.now();
    const answer = (await ask(tool, args)) as T;
    const entry = { step: current, tool, args: glimpse, ms: Date.now() - started };
    journal.push(entry);
    onCall?.(entry);
    return answer;
  }

  // The MCP reports a revert as a normal answer with an `error` field; turn it back into an exception.
  function unlessReverted<T>(answer: unknown): T {
    const err = (answer as { error?: { message?: string; data?: Hex } } | null)?.error;
    if (err) throw new RevertedCall(err.message ?? "execution reverted", err.data);
    return answer as T;
  }

  const draft = (tx: TxDraft) => ({
    from: lower(tx.from),
    to: lower(tx.to),
    ...(tx.data ? { data: tx.data } : {}),
    ...(tx.value !== undefined ? { value: hex(tx.value) } : {}),
  });

  return {
    journal,
    step(name) {
      current = name;
    },
    async blockNumber() {
      const a = await asked<{ blockNumber: string }>("get_block_number", {}, "");
      return BigInt(a.blockNumber);
    },
    async call(to, data, block) {
      const args: Record<string, unknown> = { transaction: { to: lower(to), data } };
      if (block !== undefined) args.block = hex(block);
      const a = unlessReverted<{ result: Hex }>(await asked("eth_call", args, `${short(to)} ${data.slice(0, 10)}`));
      return a.result;
    },
    async logs(q) {
      const address = Array.isArray(q.address) ? q.address.map(lower) : lower(q.address);
      const args = { address, topics: q.topics, fromBlock: hex(q.from), toBlock: hex(q.to) };
      const span = `${q.from}..${q.to}`;
      const raw = await asked<RawLog[]>("get_logs", args, span);
      return (raw ?? []).map(parseLog);
    },
    async code(a) {
      return (await asked<{ code: Hex }>("get_code", { address: lower(a) }, short(a))).code;
    },
    async balance(a) {
      return BigInt((await asked<{ balanceWei: string }>("get_balance", { address: lower(a) }, short(a))).balanceWei);
    },
    async block(n) {
      const b = await asked<{ number: Hex; hash: Hex } | null>("get_block", { block: hex(n) }, String(n));
      return b && b.hash ? { number: BigInt(b.number), hash: b.hash } : null;
    },
    async nonce(a) {
      return Number((await asked<{ nonce: string }>("get_transaction_count", { address: lower(a) }, short(a))).nonce);
    },
    async gasPrice() {
      return BigInt((await asked<{ gasPriceWei: string }>("get_gas_price", {}, "")).gasPriceWei);
    },
    async estimateGas(tx) {
      const a = unlessReverted<{ gas: string }>(await asked("estimate_gas", { transaction: draft(tx) }, `${short(tx.to)} ${(tx.data ?? "0x").slice(0, 10)}`));
      return BigInt(a.gas);
    },
    async sendRaw(raw) {
      const a = await asked<{ txHash?: Hex; hash?: Hex }>("send_raw_transaction", { rawTransaction: raw }, `${raw.length / 2 - 1} bytes`);
      const h = a.txHash ?? a.hash;
      if (!h) throw new Error(`send_raw_transaction gave no hash: ${JSON.stringify(a).slice(0, 200)}`);
      return h;
    },
    async receipt(h) {
      const r = await asked<RawReceipt | null>("get_transaction_receipt", { hash: h }, short(h));
      if (!r) return null;
      return {
        status: r.status === "0x1" || r.status === "success" ? "success" : "reverted",
        blockNumber: BigInt(r.blockNumber),
        from: lower(r.from),
        to: r.to ? lower(r.to) : null,
        logs: r.logs.map(parseLog),
      };
    },
    async transaction(h) {
      const t = await asked<RawTx | null>("get_transaction", { hash: h }, short(h));
      if (!t) return null;
      return {
        hash: t.hash,
        from: lower(t.from),
        to: t.to ? lower(t.to) : null,
        value: BigInt(t.value),
        input: t.input,
        blockNumber: t.blockNumber ? BigInt(t.blockNumber) : null,
      };
    },
  };
}

type RawLog = { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash: Hex };
type RawReceipt = { status: string; blockNumber: Hex; from: Address; to: Address | null; logs: RawLog[] };
type RawTx = { hash: Hex; from: Address; to: Address | null; value: Hex; input: Hex; blockNumber: Hex | null };

function parseLog(l: RawLog): RpcLog {
  return {
    address: lower(l.address),
    topics: l.topics.map(lower),
    data: l.data,
    blockNumber: BigInt(l.blockNumber),
    logIndex: Number(l.logIndex),
    transactionHash: l.transactionHash,
  };
}

export function short(a: string): string {
  return a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}
