// The real chain behind the saga: Pharos mainnet through viem, signing with the key from .env.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { CHAIN_ID, RPC_URL, erc20Abi, marketAbi } from "./prosper.js";
import type { Reader } from "./rotation.js";
import type { Chain, Fees, Receipt, TxSpec } from "./saga.js";

// Rate limits and dropped connections, and a node behind the load balancer that hasn't got a block yet.
const RATE_LIMIT = /too fast|cu limit|429|rate limit|fetch failed|ECONNRESET|socket hang up|header not found|unknown block|block not found|missing trie node/i;

/** RPC hiccups (rate limits, dropped connections) are retried right here, they are not saga failures. */
export async function rpc<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as { details?: string }).details ?? (e as Error).message);
      if (i >= tries - 1 || !RATE_LIMIT.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

const url = () => process.env.TRENCHSAGA_RPC || RPC_URL;
export const pharos = defineChain({
  id: CHAIN_ID,
  name: "Pharos Pacific Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

export function publicClient(): PublicClient {
  return createPublicClient({ chain: pharos, transport: http(url(), { retryCount: 0, timeout: 20_000 }) }) as PublicClient;
}

const short = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0];

export function pharosChain(client: PublicClient, account: Account): Chain {
  const wallet = createWalletClient({ account, chain: pharos, transport: http(url(), { retryCount: 0, timeout: 20_000 }) });
  return {
    account: account.address,
    async simulate(tx: TxSpec) {
      try {
        await rpc(() => client.call({ account: account.address, to: tx.to, data: tx.data, value: tx.value }));
        return { ok: true };
      } catch (e) {
        if (RATE_LIMIT.test(short(e))) throw e;
        return { ok: false, reason: short(e) };
      }
    },
    async send(tx: TxSpec, nonce: number, fees: Fees): Promise<Hex> {
      const gas = tx.gas ?? ((await rpc(() => client.estimateGas({ account: account.address, to: tx.to, data: tx.data, value: tx.value }))) * 13n) / 10n;
      return wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas, nonce, type: "eip1559", ...fees, chain: pharos });
    },
    async waitReceipt(hash: Hex, timeoutMs: number): Promise<Receipt | null> {
      // Plain polling with our own rate-limit retries: viem's waiter also reads blocks, and on the public RPC
      // those reads hit the per-second limit.
      const until = Date.now() + timeoutMs;
      for (;;) {
        const r = await rpc(() => client.getTransactionReceipt({ hash })).catch((e) => {
          if (/could not be found|not found/i.test(short(e))) return null;
          throw e;
        });
        if (r) return { hash, status: r.status, block: r.blockNumber, logs: r.logs, gasUsed: r.gasUsed, effectiveGasPrice: r.effectiveGasPrice };
        if (Date.now() >= until) return null;
        await new Promise((res) => setTimeout(res, 1_000));
      }
    },
    pendingNonce: () => rpc(() => client.getTransactionCount({ address: account.address, blockTag: "pending" })),
    async baseFee() {
      const b = await rpc(() => client.getBlock());
      return b.baseFeePerGas ?? (await rpc(() => client.getGasPrice()));
    },
  };
}

export function pharosReader(client: PublicClient): Reader {
  return {
    tokenBalance: (token: Address, owner: Address, at?: bigint) =>
      rpc(() => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner], blockNumber: at })),
    allowance: (token: Address, owner: Address, spender: Address, at?: bigint) =>
      rpc(() => client.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender], blockNumber: at })),
    quoteSell: async (market: Address, tokens: bigint) => (await rpc(() => client.readContract({ address: market, abi: marketAbi, functionName: "quoteSell", args: [tokens] })))[2],
    quoteBuy: async (market: Address, value: bigint) => (await rpc(() => client.readContract({ address: market, abi: marketAbi, functionName: "quoteBuy", args: [value] })))[3],
    now: async () => (await rpc(() => client.getBlock())).timestamp,
  };
}

/** Accepts a Prosper market or its pToken and returns both, with the token's symbol. */
export async function resolveToken(client: PublicClient, addr: Address): Promise<{ market: Address; token: Address; symbol: string }> {
  const asMarket = await rpc(() => client.readContract({ address: addr, abi: marketAbi, functionName: "pToken" })).catch(() => null);
  if (asMarket) {
    const symbol = await rpc(() => client.readContract({ address: asMarket, abi: erc20Abi, functionName: "symbol" }));
    return { market: addr, token: asMarket, symbol };
  }
  // A pToken: its market is listed by the Prosper API (the token itself has no getter for it).
  const res = await fetch("https://api.pros-per.xyz/api/v1/vaults?pageNumber=1&pageSize=100", { signal: AbortSignal.timeout(15_000) });
  const list = ((await res.json()) as { data: { list: { pToken: string; market: string }[] } }).data.list;
  const hit = list.find((v) => v.pToken.toLowerCase() === addr.toLowerCase());
  if (!hit) throw new Error(`${addr} is neither a Prosper market nor a listed pToken`);
  const symbol = await rpc(() => client.readContract({ address: addr, abi: erc20Abi, functionName: "symbol" }));
  return { market: hit.market as Address, token: addr, symbol };
}
