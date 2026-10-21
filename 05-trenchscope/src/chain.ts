// Reads one Prosper market as it is right now: a few eth_calls plus the holder list from the explorer.
// No log history is scanned, so a check takes seconds, not minutes.
import { createPublicClient, formatEther, getAddress, http, parseEther, type Address, type PublicClient } from "viem";
import { holders as explorerHolders, type Holder } from "./explorer.js";
import {
  CHAIN_ID,
  GRADUATION_TARGET_SELECTOR,
  PROS_USD_FEED,
  RPC_URL,
  TRANSFER_TOPIC,
  WPROS,
  erc20Abi,
  feedAbi,
  marketAbi,
  protocolWallets,
} from "./prosper.js";

export interface MarketSnapshot {
  market: Address;
  token: Address;
  name: string;
  symbol: string;
  block: number;
  timestamp: number;
  phase: number;
  endsAt: number;
  /** PROS (as WPROS) held by the curve right now. */
  reserve: number;
  /** PROS the curve has to raise to graduate. */
  target: number;
  /** PROS per token, from a tiny quoteBuy, before the 1% fee. */
  spot: number;
  supply: number;
  prosUsd: number | null;
  prosUsdAge: number | null;
  /** null when the explorer couldn't be reached: holder checks then can't pass. */
  holders: Holder[] | null;
  holdersError?: string;
  /** Wallets Prosper funded when the token was created (market, escrow, protocol share). */
  protocol: string[] | null;
}

const RATE_LIMIT = /too fast|cu limit|429|rate limit|timeout|timed out|fetch failed|ECONNRESET/i;

export async function retry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as { details?: string }).details ?? (e as Error).message);
      if (i >= tries - 1 || !RATE_LIMIT.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
}

export function makeClient(url = process.env.TRENCHSCOPE_RPC || RPC_URL): PublicClient {
  return createPublicClient({ transport: http(url, { retryCount: 0, timeout: 20_000 }) }) as PublicClient;
}

/** Accepts a market or a pToken address and returns both. */
export async function resolveMarket(client: PublicClient, input: string): Promise<{ market: Address; token: Address; holders: Holder[] | null; holdersError?: string; createdBlock?: number }> {
  const addr = getAddress(input);
  const asMarket = await retry(() => client.readContract({ address: addr, abi: marketAbi, functionName: "pToken" })).catch(() => null);
  const token = asMarket ? getAddress(asMarket) : addr;
  const h = await explorerHolders(token).catch((e: Error) => ({ error: e.message }));
  const list = "error" in h ? null : h.holders;
  let market = asMarket ? addr : null;
  let createdBlock: number | undefined;
  if (list) {
    // The market is one of the token's holders: a contract whose pToken() is this token.
    for (const x of list.filter((x) => x.isContract)) {
      if (market && x.address !== market.toLowerCase()) continue;
      if (!market) {
        const t = await retry(() => client.readContract({ address: getAddress(x.address), abi: marketAbi, functionName: "pToken" })).catch(() => null);
        if (!t || getAddress(t) !== token) continue;
        market = getAddress(x.address);
      }
      createdBlock = x.createdBlock;
      break;
    }
  }
  if (!market) throw new Error(asMarket ? "unreachable" : `${addr} is not a Prosper market, and no market holds it as its pToken (or the explorer is down)`);
  return { market, token, holders: list, holdersError: "error" in h ? h.error : undefined, createdBlock };
}

export async function snapshot(client: PublicClient, input: string): Promise<MarketSnapshot> {
  const chainId = await retry(() => client.getChainId());
  if (chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected Pharos mainnet (${CHAIN_ID})`);
  const r = await resolveMarket(client, input);
  const { market, token } = r;
  const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: unknown[] = []) =>
    retry(() => client.readContract({ address, abi: abi as never, functionName: functionName as never, args: args as never })) as Promise<T>;

  const block = await retry(() => client.getBlock());
  const [name, symbol, supply, phase, endsAt, reserve, targetRaw, tiny] = await Promise.all([
    read<string>(token, erc20Abi, "name"),
    read<string>(token, erc20Abi, "symbol"),
    read<bigint>(token, erc20Abi, "totalSupply"),
    read<number>(market, marketAbi, "phase"),
    read<bigint>(market, marketAbi, "endsAt"),
    read<bigint>(WPROS, erc20Abi, "balanceOf", [market]),
    retry(() => client.call({ to: market, data: GRADUATION_TARGET_SELECTOR })),
    read<readonly [bigint, bigint, bigint, bigint]>(market, marketAbi, "quoteBuy", [parseEther("0.01")]),
  ]);
  const feed = await read<readonly [bigint, bigint, bigint, bigint, bigint]>(PROS_USD_FEED, feedAbi, "latestRoundData").catch(() => null);

  let protocol: string[] | null = null;
  if (r.createdBlock !== undefined) {
    const at = `0x${r.createdBlock.toString(16)}` as const;
    const logs = await retry(() =>
      client.request({ method: "eth_getLogs", params: [{ address: token, topics: [TRANSFER_TOPIC], fromBlock: at, toBlock: at }] }),
    ).catch(() => null);
    if (logs) protocol = [...protocolWallets(logs.map((l) => ({ from: `0x${l.topics[1]!.slice(26)}`, to: `0x${l.topics[2]!.slice(26)}` })))];
  }

  return {
    market,
    token,
    name,
    symbol,
    block: Number(block.number),
    timestamp: Number(block.timestamp),
    phase: Number(phase),
    endsAt: Number(endsAt),
    reserve: Number(formatEther(reserve)),
    target: targetRaw.data ? Number(formatEther(BigInt(targetRaw.data))) : 0,
    spot: Number(formatEther(tiny[2])) / Number(formatEther(tiny[3])),
    supply: Number(formatEther(supply)),
    prosUsd: feed ? Number(formatEther(feed[1])) : null,
    prosUsdAge: feed ? Number(block.timestamp - feed[3]) : null,
    holders: r.holders,
    holdersError: r.holdersError,
    protocol,
  };
}

export async function quoteBuy(client: PublicClient, market: Address, pros: number) {
  const q = await retry(() => client.readContract({ address: market, abi: marketAbi, functionName: "quoteBuy", args: [parseEther(String(pros))] }));
  return { gross: q[0], fee: q[1], net: q[2], tokensOut: q[3] };
}

export async function quoteSell(client: PublicClient, market: Address, tokens: bigint) {
  const q = await retry(() => client.readContract({ address: market, abi: marketAbi, functionName: "quoteSell", args: [tokens] }));
  return { gross: q[0], fee: q[1], net: q[2] };
}

export async function tokenBalance(client: PublicClient, token: Address, owner: Address): Promise<bigint> {
  return retry(() => client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] }));
}
