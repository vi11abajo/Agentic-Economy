// The chain side. The simulation itself (eth_call, estimate_gas), reads, nonce and broadcast go through the
// hosted Pharos Chain MCP (mcp.pharos.xyz). The call trace, which says what the transaction would move, comes
// from debug_traceCall on the Pharos RPC: the Chain MCP has no trace tool.
import { PharosMcp, McpToolError } from "@agentic-economy/pharos-mcp";
import type { Address, Hex } from "viem";

export const RPC_URL = process.env.PREFLIGHT_RPC || "https://rpc.pharos.xyz";

export interface TxRequest {
  from: Address;
  to: Address;
  data: Hex;
  value: bigint;
}

/** eth_call outcome: the return data, or the revert with its raw data and the node's message. */
export type CallResult = { ok: true; data: Hex } | { ok: false; data?: Hex; message: string };

export interface TraceLog {
  address: Address;
  topics: Hex[];
  data: Hex;
}

/** One frame of callTracer's output (withLog: true). */
export interface Frame {
  type: string;
  from: Address;
  to?: Address;
  value?: Hex;
  input?: Hex;
  output?: Hex;
  error?: string;
  logs?: TraceLog[];
  calls?: Frame[];
}

export interface Receipt {
  hash: Hex;
  status: "success" | "reverted";
  block: bigint;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: TraceLog[];
}

/** What the simulator needs (a fake one is used in tests). */
export interface Chain {
  blockNumber(): Promise<bigint>;
  call(tx: TxRequest, block?: bigint): Promise<CallResult>;
  read(to: Address, data: Hex, block?: bigint): Promise<Hex>;
  estimateGas(tx: TxRequest): Promise<CallResult & { gas?: bigint }>;
  gasPrice(): Promise<{ gasPrice: bigint; priority: bigint }>;
  balance(address: Address, block?: bigint): Promise<bigint>;
  code(address: Address): Promise<Hex>;
  trace(tx: TxRequest, block?: bigint): Promise<Frame | null>;
  nonce(address: Address): Promise<number>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt | null>;
  close(): Promise<void>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const big = (s: unknown) => (s === undefined || s === null ? 0n : BigInt(s as string));
const blockArg = (b?: bigint) => (b === undefined ? {} : { block: Number(b) });
const txArg = (t: TxRequest) => ({ from: t.from, to: t.to, data: t.data, value: hex(t.value) });

/** A revert comes back either as {"error": {...}} in the tool text or as an MCP tool error with that text. */
function asRevert(e: unknown): { data?: Hex; message: string } | null {
  const body = e instanceof McpToolError ? e.body : (e as { error?: unknown })?.error ? JSON.stringify(e) : null;
  if (!body) return null;
  try {
    const j = JSON.parse(body) as { error?: { message?: string; data?: Hex } };
    if (j.error) return { data: j.error.data, message: j.error.message ?? "reverted" };
  } catch {
    // not JSON
  }
  return /revert/i.test(body) ? { message: body } : null;
}

export class ChainMcp implements Chain {
  private constructor(private readonly mcp: PharosMcp) {}

  static async open(): Promise<ChainMcp> {
    const mcp = new PharosMcp("preflight");
    await mcp.connect();
    return new ChainMcp(mcp);
  }

  close(): Promise<void> {
    return this.mcp.close();
  }

  private async tool<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.mcp.call<T & { error?: { message?: string; data?: Hex } }>(name, args);
    if (r && typeof r === "object" && "error" in r && r.error) throw new McpToolError(name, JSON.stringify(r));
    return r;
  }

  async blockNumber() {
    return big((await this.tool<{ blockNumber: string }>("get_block_number")).blockNumber);
  }

  async call(tx: TxRequest, block?: bigint): Promise<CallResult> {
    try {
      return { ok: true, data: (await this.tool<{ result: Hex }>("eth_call", { transaction: txArg(tx), ...blockArg(block) })).result };
    } catch (e) {
      const r = asRevert(e);
      if (r) return { ok: false, ...r };
      throw e;
    }
  }

  async read(to: Address, data: Hex, block?: bigint) {
    return (await this.tool<{ result: Hex }>("eth_call", { transaction: { to, data }, ...blockArg(block) })).result;
  }

  async estimateGas(tx: TxRequest) {
    try {
      const r = await this.tool<{ gas: string }>("estimate_gas", { transaction: txArg(tx) });
      return { ok: true as const, data: "0x" as Hex, gas: big(r.gas) };
    } catch (e) {
      const r = asRevert(e) ?? (e instanceof McpToolError ? { message: e.body } : null);
      if (r) return { ok: false as const, ...r };
      throw e;
    }
  }

  async gasPrice() {
    const r = await this.tool<{ gasPriceWei: string; maxPriorityFeePerGasWei: string }>("get_gas_price");
    return { gasPrice: big(r.gasPriceWei), priority: big(r.maxPriorityFeePerGasWei) };
  }

  async balance(address: Address, block?: bigint) {
    return big((await this.tool<{ balanceWei: string }>("get_balance", { address, ...blockArg(block) })).balanceWei);
  }

  async code(address: Address) {
    return ((await this.tool<{ code?: Hex }>("get_code", { address })).code ?? "0x") as Hex;
  }

  async trace(tx: TxRequest, block?: bigint): Promise<Frame | null> {
    for (let i = 0; i < 4; i++) {
      const res = await fetch(RPC_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "debug_traceCall",
          params: [txArg(tx), block === undefined ? "latest" : hex(block), { tracer: "callTracer", tracerConfig: { withLog: true } }],
        }),
        signal: AbortSignal.timeout(30_000),
      }).catch(() => null);
      const j = res ? ((await res.json().catch(() => null)) as { result?: Frame; error?: { message?: string } } | null) : null;
      if (j?.result) return j.result;
      // Rate limits and a node that hasn't got the block yet are retried; anything else means no trace.
      if (j?.error && !/too fast|cu limit|rate|not available|header not found|unknown block/i.test(j.error.message ?? "")) return null;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
    return null;
  }

  async nonce(address: Address) {
    return Number((await this.tool<{ nonce: string }>("get_transaction_count", { address, block: "pending" })).nonce);
  }

  async sendRaw(raw: Hex) {
    const r = await this.tool<Record<string, unknown>>("send_raw_transaction", { rawTransaction: raw });
    const h = (r.txHash ?? r.transactionHash ?? r.hash ?? r.result) as Hex | undefined; // the hosted MCP answers {txHash}
    if (!h) throw new Error(`send_raw_transaction gave no hash: ${JSON.stringify(r).slice(0, 200)}`);
    return h;
  }

  async receipt(hash: Hex): Promise<Receipt | null> {
    const r = await this.tool<Record<string, unknown> | null>("get_transaction_receipt", { hash });
    if (!r || !r.blockNumber) return null;
    return {
      hash,
      status: big(r.status) === 1n ? "success" : "reverted",
      block: big(r.blockNumber),
      gasUsed: big(r.gasUsed),
      effectiveGasPrice: big(r.effectiveGasPrice),
      logs: (r.logs as TraceLog[]) ?? [],
    };
  }
}
