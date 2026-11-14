// Watches Prosper's factory for new markets, block by block, over plain RPC. Every MarketCreated becomes a launch,
// checked on chain (real market? still on the curve? how much PROS already in?) before anyone hears about it.
import { EventEmitter } from "node:events";
import { getAddress, type Address } from "viem";
import { client } from "./chain.js";
import { checkMarket, type MarketCheck } from "./market.js";
import { PROSPER_FACTORY } from "./protocol.js";
import type { Launch } from "./store.js";

export const MARKET_CREATED = "0x6d679d9dcb91cccb2f253f24f8f9b53871eac50c475cb8335cfdd93a32212865";

export interface RawLog {
  blockNumber: string;
  data: string;
  topics: string[];
  transactionHash: string;
}
export interface WatcherDeps {
  head: () => Promise<bigint>;
  logs: (from: bigint, to: bigint) => Promise<RawLog[]>;
  check: (market: Address) => Promise<MarketCheck>;
  startBlock?: bigint;
}

// topics: [sig, vault, (hash), pToken]; data: market, buyback
export function decodeMarketCreated(l: RawLog) {
  return {
    vault: getAddress(`0x${l.topics[1].slice(26)}`),
    pToken: getAddress(`0x${l.topics[3].slice(26)}`),
    market: getAddress(`0x${l.data.slice(26, 66)}`),
  };
}

export const rpcWatcherDeps = (amountIn: () => bigint): WatcherDeps => ({
  // one block behind the head: the newest block is sometimes "not available" for state reads yet
  head: async () => (await client.getBlockNumber({ cacheTime: 0 })) - 1n,
  logs: async (from, to) =>
    (await client.request({
      method: "eth_getLogs",
      params: [{ address: PROSPER_FACTORY, topics: [MARKET_CREATED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
    } as never)) as RawLog[],
  check: (m) => checkMarket(m, amountIn()),
});

export class LaunchWatcher extends EventEmitter {
  private last: bigint | null;
  private running = false;

  constructor(private deps: WatcherDeps) {
    super();
    this.last = deps.startBlock ?? null;
  }

  /** One pass: read every new block since the last pass (at most 1,000 at a time, the node's log limit). */
  async tick(): Promise<void> {
    const head = await this.deps.head();
    let last: bigint = this.last ?? head;
    while (last < head) {
      const from: bigint = last + 1n;
      const to: bigint = head - from >= 999n ? from + 999n : head;
      for (const l of await this.deps.logs(from, to)) {
        const d = decodeMarketCreated(l);
        const checks = await this.deps.check(d.market).catch(() => null);
        const launch: Launch = { ...d, block: BigInt(l.blockNumber), tx: l.transactionHash, checks };
        this.emit("launch", launch);
      }
      last = to;
      this.last = last;
    }
    this.last = last;
  }

  start(intervalMs = 1000) {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      while (this.running) {
        try { await this.tick(); } catch (e) { this.emit("error", e); }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
    };
    void loop();
  }

  stop() { this.running = false; }
}
