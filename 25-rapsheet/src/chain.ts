// What rapsheet asks Pharos itself. Anything the verdict leans on is read here, not taken from the explorer: whether
// there is code, when it appeared, which implementation a proxy points at right now and since when, who owns it, and
// whether an approval is still open. Behind an interface so the signals run against a fake chain in the tests.
import { createPublicClient, erc20Abi, http, parseAbi } from "viem";
import type { Hex } from "./explorer.js";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER_TX = "https://www.pharosscan.xyz/tx/";
export const EXPLORER_ADDRESS = "https://www.pharosscan.xyz/address/";
export const EXPLORER_BLOCK = "https://www.pharosscan.xyz/block/";

// EIP-1967: keccak256("eip1967.proxy.implementation") - 1 and keccak256("eip1967.proxy.admin") - 1.
export const IMPL_SLOT: Hex = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ADMIN_SLOT: Hex = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
// Upgraded(address indexed implementation)
export const UPGRADED_TOPIC: Hex = "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b";

export interface UpgradeLog {
  block: number;
  hash: Hex;
  impl: Hex;
}

export interface Chain {
  head(): Promise<number>;
  blockTime(n: number): Promise<number>;
  /** Runtime bytecode, "0x" for a plain wallet (or before the contract existed, when `block` is given). */
  code(a: Hex, block?: number): Promise<Hex>;
  storage(a: Hex, slot: Hex, block?: number): Promise<Hex>;
  nonce(a: Hex): Promise<number>;
  /** owner() if the contract answers it, null if it doesn't. */
  owner(a: Hex): Promise<Hex | null>;
  allowance(token: Hex, owner: Hex, spender: Hex): Promise<bigint | null>;
  /** Upgraded events emitted by `a` in [from, to]; the caller keeps the span within what the node allows. */
  upgrades(a: Hex, from: number, to: number): Promise<UpgradeLog[]>;
  /** Block and sender of a mined transaction, null if the node doesn't know it. */
  txBlock(hash: Hex): Promise<{ block: number; from: Hex } | null>;
  /** Calldata of a transaction, null if the node doesn't know it. */
  txInput(hash: Hex): Promise<Hex | null>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const throttled = (e: unknown) => /too fast|cu limit|rate limit|429/i.test(String((e as { details?: string })?.details ?? "") + String((e as Error)?.message ?? e));

/**
 * The public Pharos RPC answers "cu limit exceeded; Request too fast per second" (code -32011) when pushed, and viem
 * doesn't treat that as retryable. Wait and ask again; any other error goes straight on.
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

/** The address in the low 20 bytes of a storage word, or null for an empty slot. */
export function slotAddress(word: Hex): Hex | null {
  const tail = word.slice(-40).toLowerCase();
  return /^0+$/.test(tail) ? null : (`0x${tail}` as Hex);
}

const ownable = parseAbi(["function owner() view returns (address)"]);

export function viemChain(rpc = PHAROS_RPC): Chain {
  const c = createPublicClient({ transport: http(rpc, { batch: { batchSize: 20 }, retryCount: 4, retryDelay: 1500 }) });
  const times = new Map<number, number>();
  const at = (block?: number) => (block === undefined ? {} : { blockNumber: BigInt(block) });
  return {
    head: async () => Number(await patiently(() => c.getBlockNumber())),
    async blockTime(n) {
      let t = times.get(n);
      if (t === undefined) {
        t = Number((await patiently(() => c.getBlock({ blockNumber: BigInt(n) }))).timestamp);
        times.set(n, t);
      }
      return t;
    },
    code: async (a, block) => ((await patiently(() => c.getCode({ address: a, ...at(block) }))) ?? "0x") as Hex,
    storage: async (a, slot, block) => ((await patiently(() => c.getStorageAt({ address: a, slot, ...at(block) }))) ?? "0x0") as Hex,
    nonce: (a) => patiently(() => c.getTransactionCount({ address: a })),
    async owner(a) {
      try {
        return ((await patiently(() => c.readContract({ address: a, abi: ownable, functionName: "owner" }))) as string).toLowerCase() as Hex;
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
    async allowance(token, owner, spender) {
      try {
        return await patiently(() => c.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] }));
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
    async upgrades(a, from, to) {
      const logs = await patiently(() => c.getLogs({ address: a, fromBlock: BigInt(from), toBlock: BigInt(to), topics: [UPGRADED_TOPIC] } as any));
      return (logs as any[]).map((l) => ({
        block: Number(l.blockNumber),
        hash: String(l.transactionHash).toLowerCase() as Hex,
        impl: `0x${String(l.topics[1]).slice(-40).toLowerCase()}` as Hex,
      }));
    },
    async txBlock(hash) {
      try {
        const r = await patiently(() => c.getTransactionReceipt({ hash }));
        return { block: Number(r.blockNumber), from: r.from.toLowerCase() as Hex };
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
    async txInput(hash) {
      try {
        return (await patiently(() => c.getTransaction({ hash }))).input as Hex;
      } catch (e) {
        if (throttled(e)) throw e;
        return null;
      }
    },
  };
}
