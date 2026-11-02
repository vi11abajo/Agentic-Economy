// Test helpers: synthetic Prosper logs and an in-memory Chain. Not used by the CLI.
import { encodeAbiParameters, encodeEventTopics, pad, parseEther, type Hex } from "viem";
import type { Chain } from "./chain.js";
import { curveEvents, MARKET_CREATED, PROSPER_FACTORY, type RpcLog } from "./prosper.js";

let seq = 0;
const hx = (n: number) => `0x${n.toString(16)}` as Hex;
export const addr = (n: number) => pad(hx(n), { size: 20 }).toLowerCase();

const base = (address: string, block: number, time?: number) => ({
  address: address as Hex,
  blockNumber: hx(block),
  blockTimestamp: hx(time ?? 1_790_000_000 + block),
  transactionHash: pad(hx(++seq), { size: 32 }),
  logIndex: hx(0),
});

export function created(market: string, pToken: string, block: number): RpcLog {
  return {
    ...base(PROSPER_FACTORY, block),
    topics: [MARKET_CREATED, pad(addr(9001) as Hex), pad(addr(9002) as Hex), pad(pToken as Hex)],
    data: encodeAbiParameters([{ type: "address" }, { type: "address" }], [market as Hex, addr(9003) as Hex]),
  };
}

/** A buy of `pros` PROS (1% fee) at `price` PROS per token. */
export function buy(market: string, trader: string, pros: number, price: number, block: number, time?: number): RpcLog {
  const net = pros * 0.99;
  return {
    ...base(market, block, time),
    topics: encodeEventTopics({ abi: curveEvents, eventName: "Bought", args: { router: addr(9004) as Hex, trader: trader as Hex } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
      [parseEther(String(pros)), parseEther(net.toFixed(12)), parseEther((net / price).toFixed(12)), parseEther((pros - net).toFixed(12))],
    ),
  };
}

/** A sell receiving `pros` PROS net at `price` PROS per token. */
export function sell(market: string, trader: string, pros: number, price: number, block: number, time?: number): RpcLog {
  const gross = pros / 0.99;
  return {
    ...base(market, block, time),
    topics: encodeEventTopics({ abi: curveEvents, eventName: "Sold", args: { router: addr(9004) as Hex, trader: trader as Hex } }) as Hex[],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "bool" }],
      [parseEther((gross / price).toFixed(12)), parseEther(gross.toFixed(12)), parseEther(String(pros)), parseEther((gross - pros).toFixed(12)), true] as never,
    ),
  };
}

export interface FakeChain extends Chain {
  logCalls: Array<[number, number]>;
  phases: Record<string, (block: number) => number | null>;
}

/** Blocks tick 1 per second from `t0` unless `times` says otherwise. */
export function fakeChain(logs: RpcLog[], opts: { head: number; t0?: number; times?: (b: number) => number } = { head: 0 }): FakeChain {
  const t0 = opts.t0 ?? 1_790_000_000;
  const fc: FakeChain = {
    logCalls: [],
    phases: {},
    head: async () => opts.head,
    blockTime: async (b) => (opts.times ? opts.times(b) : t0 + b),
    logs: async (from, to) => {
      if (to - from > 999) throw new Error(`window ${from}-${to} is over 1000 blocks`);
      fc.logCalls.push([from, to]);
      return logs.filter((l) => Number(BigInt(l.blockNumber)) >= from && Number(BigInt(l.blockNumber)) <= to);
    },
    phase: async (m, b) => (fc.phases[m] ? fc.phases[m](b) : 0),
    token: async (a) => ({ symbol: `T${a.slice(-4)}`, decimals: 18 }),
  };
  return fc;
}

import type { Digest, Metrics } from "./types.js";

export const sampleMetrics = (volume = 48210): Metrics => ({ volume, buys: volume * 0.6, sells: volume * 0.4, netFlow: volume * 0.2, trades: 1342, traders: 211, newTraders: 64, fees: volume / 100, newMarkets: 5, graduated: 2, onCurve: 13 });

/** A filled digest for renderer and delivery tests. */
export function sampleDigest(over: Partial<Digest> = {}): Digest {
  const tokens = Array.from({ length: 20 }, (_, i) => ({ market: addr(100 + i), symbol: i === 0 ? "K<T>" : `TOK${i}`, volume: 9820 - i * 300, trades: 50 - i, firstPrice: 0.001, lastPrice: 0.002, changePct: 100, phaseEnd: 0 }));
  return {
    key: "2026-10-26_7d", label: "2026-W44", days: 7, start: 1792972800, end: 1793577600, startBlock: 21_300_000, endBlock: 21_904_799, readAt: 1793610000,
    metrics: sampleMetrics(), prev: sampleMetrics(39195), tokens,
    topTrades: [{ symbol: "KITE", side: "BUY", pros: 3100, trader: addr(77), tx: "0x" + "ab".repeat(32) }],
    newMarkets: ["KITE"], graduated: ["MOON"],
    events: [
      { kind: "graduation", score: 100, title: "$MOON graduated to FaroSwap", market: addr(5) },
      { kind: "big_trade", score: 90, title: "0x1234…abcd bought 3,100 PROS of $KITE", tx: "0x" + "ab".repeat(32) },
      { kind: "mover", score: 80, title: "$ORB price +184% over the week" },
    ],
    candidates: [], trends: ["Volume up for the 3rd week in a row"], delivered: {},
    ...over,
  };
}
