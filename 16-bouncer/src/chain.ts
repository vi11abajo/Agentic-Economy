// Everything bouncer asks Pharos goes through one small Chain interface. The real one talks JSON-RPC to the public
// node (it rate-limits bursts with -32011, so we nap and ask again). The trace comes from debug_traceCall on the
// RPC because the Chain MCP has no trace tool (we learned that in 09-preflight). A taped chain writes every
// answer down and fromTape replays them, so the tests run offline against what mainnet really said.
import type { Address, Hex } from "viem";

export type TxReq = { from: Address; to: Address; data: Hex; value: bigint };
export type TraceLog = { address: Address; topics: Hex[]; data: Hex };
/** One frame of callTracer's output with withLog on. */
export type Frame = { type: string; from: Address; to?: Address; value?: Hex; input?: Hex; output?: Hex; error?: string; logs?: TraceLog[]; calls?: Frame[] };
export type Receipt = { status: "success" | "reverted"; gasUsed: bigint; blockNumber: bigint; logs: TraceLog[] };

export interface Chain {
  blockNumber(): Promise<bigint>;
  trace(tx: TxReq, block: bigint): Promise<Frame>;
  estimateGas(tx: TxReq, block: bigint): Promise<bigint | null>;
  code(a: Address, block: bigint): Promise<Hex>;
  balance(a: Address, block: bigint): Promise<bigint>;
  gasPrice(): Promise<bigint>;
  nonce(a: Address): Promise<number>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt | null>;
}

export const PHAROS_RPC = "https://rpc.pharos.xyz";
export const CHAIN_ID = 1672;

const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;
const rpcTx = (tx: TxReq) => ({ from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value) });

type RpcError = { code: number; message: string; data?: Hex };
class NodeSaidNo extends Error {
  constructor(readonly answer: RpcError) {
    super(answer.message);
  }
}
// "execution reverted" (code 3) is the EVM saying no; anything else is the node having a problem.
const isRevert = (e: RpcError) => e.code === 3 || /revert/i.test(e.message);

export function rpcChain(url = PHAROS_RPC, deps: { fetch?: typeof fetch; sleep?: (ms: number) => Promise<void> } = {}): Chain {
  const doFetch = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function rpc<T>(method: string, params: unknown[]): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(30_000) });
      const busy = res.status === 429;
      const body = busy ? null : ((await res.json()) as { result?: T; error?: RpcError });
      const limited = busy || body?.error?.code === -32011;
      if (limited && attempt < 8) {
        await sleep(1500);
        continue;
      }
      if (busy) throw new Error(`${url} kept answering HTTP 429 to ${method}`);
      if (body!.error) throw new NodeSaidNo(body!.error);
      return body!.result as T;
    }
  }

  return {
    blockNumber: async () => BigInt(await rpc<Hex>("eth_blockNumber", [])),
    trace: (tx, block) => rpc<Frame>("debug_traceCall", [rpcTx(tx), hex(block), { tracer: "callTracer", tracerConfig: { withLog: true } }]),
    async estimateGas(tx, block) {
      try {
        return BigInt(await rpc<Hex>("eth_estimateGas", [rpcTx(tx), hex(block)]));
      } catch (err) {
        if (err instanceof NodeSaidNo && isRevert(err.answer)) return null; // no gas amount makes it pass
        throw err;
      }
    },
    code: (a, block) => rpc<Hex>("eth_getCode", [a, hex(block)]),
    balance: async (a, block) => BigInt(await rpc<Hex>("eth_getBalance", [a, hex(block)])),
    gasPrice: async () => BigInt(await rpc<Hex>("eth_gasPrice", [])),
    nonce: async (a) => Number(BigInt(await rpc<Hex>("eth_getTransactionCount", [a, "pending"]))),
    sendRaw: (raw) => rpc<Hex>("eth_sendRawTransaction", [raw]),
    async receipt(hash) {
      const r = await rpc<{ status: Hex; gasUsed: Hex; blockNumber: Hex; logs: TraceLog[] } | null>("eth_getTransactionReceipt", [hash]);
      if (!r) return null;
      return { status: r.status === "0x1" ? "success" : "reverted", gasUsed: BigInt(r.gasUsed), blockNumber: BigInt(r.blockNumber), logs: r.logs };
    },
  };
}

export type Tape = Record<string, unknown>;
const keyOf = (method: string, args: unknown[]) => `${method} ${JSON.stringify(args, (_, v) => (typeof v === "bigint" ? `${v}n` : v))}`;
const flatten = (v: unknown) => (v === undefined ? null : JSON.parse(JSON.stringify(v, (_, x) => (typeof x === "bigint" ? `${x}n` : x))));
const revive = (v: unknown) => JSON.parse(JSON.stringify(v), (_, x) => (typeof x === "string" && /^-?\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x));
const METHODS: Array<keyof Chain> = ["blockNumber", "trace", "estimateGas", "code", "balance", "gasPrice", "nonce", "sendRaw", "receipt"];

/** Wraps a chain and writes down every question with its answer, so the same run can be replayed offline. */
export function taped(real: Chain, tape: Tape): Chain {
  const out = {} as Record<string, unknown>;
  for (const m of METHODS)
    out[m] = async (...args: unknown[]) => {
      const answer = await (real[m] as (...a: unknown[]) => Promise<unknown>).apply(real, args);
      tape[keyOf(m, args)] = flatten(answer);
      return answer;
    };
  return out as unknown as Chain;
}

/** A chain that only knows what's on the tape; asking anything else is a test bug, so it says so loudly. */
export function fromTape(tape: Tape): Chain {
  const out = {} as Record<string, unknown>;
  for (const m of METHODS)
    out[m] = async (...args: unknown[]) => {
      const key = keyOf(m, args);
      if (!(key in tape)) throw new Error(`not on the tape: ${key.slice(0, 200)}`);
      return revive(tape[key]);
    };
  return out as unknown as Chain;
}
