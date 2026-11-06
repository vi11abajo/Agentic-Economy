// The only door to the chain. Everything dent knows comes through here as a plain JSON-RPC read against the
// public Pharos node. There is deliberately no method that sends a transaction: dent can look and simulate,
// it can't spend.
import type { Hex } from "viem";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";

/** State override, the third parameter of eth_call / eth_estimateGas. Lets us pretend a wallet already has the money. */
export type Overrides = Record<string, { balance?: Hex; stateDiff?: Record<Hex, Hex> }>;

export interface Tx {
  from?: string;
  to: string;
  data: Hex;
  value?: bigint;
}

/** What a call came back with. A revert is an answer too, and we keep its data so we can say why. */
export type CallResult = { ok: true; data: Hex } | { ok: false; revert: Hex; message: string };

export interface Chain {
  head(): Promise<number>;
  timestamp(block: number): Promise<number>;
  call(tx: Tx, block?: number | "latest", overrides?: Overrides): Promise<CallResult>;
  estimateGas(tx: Tx, overrides?: Overrides): Promise<CallResult & { gas?: bigint }>;
  gasPrice(): Promise<bigint>;
  nativeBalance(who: string, block?: number | "latest"): Promise<bigint>;
  receipt(hash: string): Promise<{ status: "success" | "reverted"; blockNumber: number; gasUsed: bigint } | null>;
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
  /** How many requests actually went out, so a run can say what it cost. */
  requests = 0;
  private readonly stamps = new Map<number, number>();

  constructor(private readonly url = PHAROS_RPC, private readonly maxInFlight = 4) {}

  // The public node answers "-32011 cu limit exceeded; Request too fast per second" when pushed. viem doesn't
  // retry that code, so we pace ourselves and retry it here.
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
          });
          body = (await res.json()) as typeof body;
        } catch (e) {
          if (attempt < 5) {
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

  async head(): Promise<number> {
    return Number(await this.must<Hex>("eth_blockNumber", []));
  }

  async timestamp(block: number): Promise<number> {
    const known = this.stamps.get(block);
    if (known !== undefined) return known;
    const b = await this.must<{ timestamp: Hex }>("eth_getBlockByNumber", [hex(block), false]);
    const t = Number(b.timestamp);
    this.stamps.set(block, t);
    return t;
  }

  async call(tx: Tx, block?: number | "latest", overrides?: Overrides): Promise<CallResult> {
    const params: unknown[] = [txJson(tx), tag(block)];
    if (overrides) params.push(overrides);
    const r = await this.raw<Hex>("eth_call", params);
    if (r.error) return { ok: false, revert: (r.error.data ?? "0x") as Hex, message: r.error.message };
    return { ok: true, data: (r.result ?? "0x") as Hex };
  }

  async estimateGas(tx: Tx, overrides?: Overrides): Promise<CallResult & { gas?: bigint }> {
    const params: unknown[] = [txJson(tx), "latest"];
    if (overrides) params.push(overrides);
    const r = await this.raw<Hex>("eth_estimateGas", params);
    if (r.error) return { ok: false, revert: (r.error.data ?? "0x") as Hex, message: r.error.message };
    return { ok: true, data: "0x", gas: BigInt(r.result!) };
  }

  async gasPrice(): Promise<bigint> {
    return BigInt(await this.must<Hex>("eth_gasPrice", []));
  }

  async nativeBalance(who: string, block?: number | "latest"): Promise<bigint> {
    return BigInt(await this.must<Hex>("eth_getBalance", [who, tag(block)]));
  }

  async receipt(hash: string) {
    const r = await this.must<{ status: Hex; blockNumber: Hex; gasUsed: Hex } | null>("eth_getTransactionReceipt", [hash]);
    if (!r) return null;
    return {
      status: (r.status === "0x1" ? "success" : "reverted") as "success" | "reverted",
      blockNumber: Number(r.blockNumber),
      gasUsed: BigInt(r.gasUsed),
    };
  }
}

/**
 * The block closest to `secondsAgo` before `head`, found by bisection on timestamps. Pharos block time isn't a
 * constant we want to bet on, so we ask the chain.
 */
export async function blockSecondsAgo(chain: Pick<Chain, "timestamp">, head: number, secondsAgo: number): Promise<number> {
  const target = (await chain.timestamp(head)) - secondsAgo;
  let lo = 1;
  let hi = head;
  if ((await chain.timestamp(lo)) > target) return lo;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await chain.timestamp(mid)) <= target) lo = mid;
    else hi = mid;
  }
  return lo;
}
