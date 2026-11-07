// Every byte knock knows comes through this file: plain JSON-RPC reads. The same class talks to Pharos (where the
// payment happens) and to Ethereum (where .eth names live). There is no method here that sends a transaction, on
// purpose: knock prepares, your wallet signs.
import type { Hex } from "viem";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const ETHEREUM_RPC = process.env.ETHEREUM_RPC_URL ?? "https://ethereum-rpc.publicnode.com";

export type Overrides = Record<string, { balance?: Hex; code?: Hex; stateDiff?: Record<Hex, Hex> }>;

export interface Tx {
  from?: string;
  to: string;
  data?: Hex;
  value?: bigint;
}

/** What a call came back with. A revert is an answer too, and we keep its data so we can say why. */
export type CallResult = { ok: true; data: Hex } | { ok: false; revert: Hex; message: string };

/** One frame of a callTracer trace (withLog on): who called whom, with what, and which events fell out. */
export interface CallFrame {
  type: string;
  from: Hex;
  to?: Hex;
  value?: Hex;
  input: Hex;
  output?: Hex;
  error?: string;
  calls?: CallFrame[];
  logs?: { address: Hex; topics: Hex[]; data: Hex }[];
}

export interface Receipt {
  status: "success" | "reverted";
  blockNumber: number;
  gasUsed: bigint;
}

export interface Chain {
  head(): Promise<number>;
  call(tx: Tx, block?: number | "latest", overrides?: Overrides): Promise<CallResult>;
  estimateGas(tx: Tx): Promise<CallResult & { gas?: bigint }>;
  gasPrice(): Promise<bigint>;
  nativeBalance(who: string): Promise<bigint>;
  code(who: string): Promise<Hex>;
  nonce(who: string): Promise<number>;
  storage(who: string, slot: Hex): Promise<Hex>;
  trace(tx: Tx): Promise<CallFrame | null>;
  receipt(hash: string): Promise<Receipt | null>;
  txInput(hash: string): Promise<{ from: Hex; to: Hex | null; input: Hex; value: bigint } | null>;
}

const hex = (n: bigint | number) => `0x${n.toString(16)}` as Hex;
const tag = (b: number | "latest" | undefined) => (b === undefined || b === "latest" ? "latest" : hex(b));
const txJson = (t: Tx) => ({ from: t.from, to: t.to, data: t.data, value: t.value ? hex(t.value) : undefined });

interface RpcError {
  code: number;
  message: string;
  data?: Hex;
}

export class RpcChain implements Chain {
  private id = 0;
  private inFlight = 0;
  private readonly waiting: (() => void)[] = [];
  requests = 0;

  constructor(
    readonly url = PHAROS_RPC,
    private readonly maxInFlight = 4,
    private readonly timeoutMs = 15_000,
  ) {}

  // The public Pharos node answers "-32011 cu limit exceeded; Request too fast per second" when pushed. viem
  // doesn't retry that code, so we pace ourselves and retry it here.
  private async raw<T>(method: string, params: unknown[]): Promise<{ result?: T; error?: RpcError }> {
    while (this.inFlight >= this.maxInFlight) await new Promise<void>((r) => this.waiting.push(r));
    this.inFlight++;
    try {
      for (let attempt = 0; ; attempt++) {
        this.requests++;
        let body: { result?: T; error?: RpcError };
        try {
          const res = await fetch(this.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          body = (await res.json()) as typeof body;
        } catch (e) {
          if (attempt < 3) {
            await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
            continue;
          }
          throw e;
        }
        if (body.error?.code === -32011 && attempt < 8) {
          await new Promise((r) => setTimeout(r, 400 + 300 * attempt));
          continue;
        }
        return body;
      }
    } finally {
      this.inFlight--;
      this.waiting.shift()?.();
    }
  }

  private async must<T>(method: string, params: unknown[]): Promise<T> {
    const r = await this.raw<T>(method, params);
    if (r.error || r.result === undefined) throw new Error(`${method} failed: ${r.error?.message ?? "no result"}`);
    return r.result;
  }

  async head() {
    return Number(await this.must<Hex>("eth_blockNumber", []));
  }

  async call(tx: Tx, block?: number | "latest", overrides?: Overrides): Promise<CallResult> {
    const params: unknown[] = [txJson(tx), tag(block)];
    if (overrides) params.push(overrides);
    const r = await this.raw<Hex>("eth_call", params);
    if (r.error) return { ok: false, revert: (r.error.data ?? "0x") as Hex, message: r.error.message };
    return { ok: true, data: (r.result ?? "0x") as Hex };
  }

  async estimateGas(tx: Tx): Promise<CallResult & { gas?: bigint }> {
    const r = await this.raw<Hex>("eth_estimateGas", [txJson(tx), "latest"]);
    if (r.error) return { ok: false, revert: (r.error.data ?? "0x") as Hex, message: r.error.message };
    return { ok: true, data: "0x", gas: BigInt(r.result!) };
  }

  async gasPrice() {
    return BigInt(await this.must<Hex>("eth_gasPrice", []));
  }

  async nativeBalance(who: string) {
    return BigInt(await this.must<Hex>("eth_getBalance", [who, "latest"]));
  }

  async code(who: string) {
    return this.must<Hex>("eth_getCode", [who, "latest"]);
  }

  async nonce(who: string) {
    return Number(await this.must<Hex>("eth_getTransactionCount", [who, "latest"]));
  }

  async storage(who: string, slot: Hex) {
    return this.must<Hex>("eth_getStorageAt", [who, slot, "latest"]);
  }

  // Pharos supports callTracer with withLog (checked 2026-11-07: a PROS send to WPROS shows its Deposit event).
  // It ignores state overrides, so we only ever trace what the real sender could really do.
  async trace(tx: Tx): Promise<CallFrame | null> {
    const r = await this.raw<CallFrame>("debug_traceCall", [txJson(tx), "latest", { tracer: "callTracer", tracerConfig: { withLog: true } }]);
    return r.result ?? null;
  }

  async receipt(hash: string): Promise<Receipt | null> {
    const r = await this.must<{ status: Hex; blockNumber: Hex; gasUsed: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (!r) return null;
    return { status: r.status === "0x1" ? "success" : "reverted", blockNumber: Number(r.blockNumber), gasUsed: BigInt(r.gasUsed) };
  }

  async txInput(hash: string) {
    const t = await this.must<{ from: Hex; to: Hex | null; input: Hex; value: Hex } | null>("eth_getTransactionByHash", [hash]);
    return t ? { from: t.from, to: t.to, input: t.input, value: BigInt(t.value) } : null;
  }
}
