// What tieout asks Pharos directly: block times, receipts and balances at a given block. Behind an interface so the
// report logic runs against a fake chain in the tests.
import { createPublicClient, erc20Abi, http } from "viem";
import type { Hex } from "./explorer.js";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER_TX = "https://www.pharosscan.xyz/tx/";
export const EXPLORER_ADDRESS = "https://www.pharosscan.xyz/address/";

export interface Log {
  address: Hex;
  topics: Hex[];
  data: Hex;
}

export interface Receipt {
  hash: Hex;
  ok: boolean;
  from: Hex;
  to: Hex | null;
  /** What the sender paid for gas, in wei (gas used times the effective price). */
  fee: bigint;
  logs: Log[];
}

export interface Chain {
  head(): Promise<bigint>;
  blockTime(n: bigint): Promise<number>;
  receipts(hashes: Hex[]): Promise<Map<Hex, Receipt>>;
  nativeBalance(who: Hex, block: bigint): Promise<bigint>;
  /** null when the token doesn't answer balanceOf at that block (not deployed yet, not an ERC20). */
  tokenBalance(token: Hex, who: Hex, block: bigint): Promise<bigint | null>;
  allowance(token: Hex, owner: Hex, spender: Hex, block: bigint): Promise<bigint | null>;
  tokenInfo(token: Hex): Promise<{ symbol: string; decimals: number } | null>;
}

const CHUNK = 25;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const throttled = (e: unknown) => /too fast|cu limit|rate limit|429/i.test(String((e as { details?: string })?.details ?? "") + String((e as Error)?.message ?? e));

/**
 * The public Pharos RPC answers "cu limit exceeded; Request too fast per second" (code -32011) when pushed, and viem
 * doesn't treat that as retryable. A long report makes a few hundred calls, so it waits and asks again instead of
 * dying halfway. Any other error is passed straight on.
 */
export async function patiently<T>(ask: () => Promise<T>, tries = 7, pause = 800): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await ask();
    } catch (e) {
      if (attempt >= tries || !throttled(e)) throw e;
      await sleep(pause * attempt);
    }
  }
}

export function viemChain(rpc = PHAROS_RPC): Chain {
  // batch: concurrent calls go out as one JSON-RPC batch, which Pharos accepts. Saves a lot on long reports.
  const c = createPublicClient({ transport: http(rpc, { batch: { batchSize: CHUNK }, retryCount: 4, retryDelay: 1500 }) });
  const times = new Map<bigint, number>();
  return {
    head: () => patiently(() => c.getBlockNumber()),
    async blockTime(n) {
      let t = times.get(n);
      if (t === undefined) {
        t = Number((await patiently(() => c.getBlock({ blockNumber: n }))).timestamp);
        times.set(n, t);
      }
      return t;
    },
    async receipts(hashes) {
      const out = new Map<Hex, Receipt>();
      for (let i = 0; i < hashes.length; i += CHUNK) {
        const got = await Promise.all(hashes.slice(i, i + CHUNK).map((hash) => patiently(() => c.getTransactionReceipt({ hash }))));
        for (const r of got) {
          out.set(r.transactionHash.toLowerCase() as Hex, {
            hash: r.transactionHash.toLowerCase() as Hex,
            ok: r.status === "success",
            from: r.from.toLowerCase() as Hex,
            to: (r.to?.toLowerCase() as Hex) ?? null,
            fee: r.gasUsed * r.effectiveGasPrice,
            logs: r.logs.map((l) => ({ address: l.address.toLowerCase() as Hex, topics: l.topics as Hex[], data: l.data as Hex })),
          });
        }
      }
      return out;
    },
    nativeBalance: (who, block) => patiently(() => c.getBalance({ address: who, blockNumber: block })),
    async tokenBalance(token, who, block) {
      try {
        return await patiently(() => c.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who], blockNumber: block }));
      } catch (e) {
        // a token that reverts really has no answer; a node that kept saying "too fast" is a failure, not a zero
        if (throttled(e)) throw e;
        return null;
      }
    },
    async allowance(token, owner, spender, block) {
      try {
        return await patiently(() => c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], blockNumber: block }));
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
    async tokenInfo(token) {
      try {
        const [symbol, decimals] = await Promise.all([
          patiently(() => c.readContract({ address: token, abi: erc20Abi, functionName: "symbol" })),
          patiently(() => c.readContract({ address: token, abi: erc20Abi, functionName: "decimals" })),
        ]);
        return { symbol, decimals };
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
  };
}
