// Prosper (pros-per.xyz) contracts on Pharos Pacific Mainnet and how to decode their logs. Forked from
// services/prosper-monitor/src/prosper.ts (event signatures recovered there from real on-chain logs).
import { decodeEventLog, formatUnits, getAddress, parseAbi, toEventSelector, type Hex } from "viem";

export const PROSPER_FACTORY = "0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8";
/** ProsperFactory: topics = (vault, creator, pToken), data = (market, buyback). */
export const MARKET_CREATED = "0x6d679d9dcb91cccb2f253f24f8f9b53871eac50c475cb8335cfdd93a32212865";
/** First block worth scanning for ProsperFactory activity. */
export const SCAN_START = 17_515_618;

export const curveEvents = parseAbi([
  "event Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)",
  "event Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)",
]);
export const BOUGHT = toEventSelector(curveEvents[0]);
export const SOLD = toEventSelector(curveEvents[1]);
/** phase() of a market: 0 on curve, 1 migrating, 2 graduated (FaroSwap), 3 curve only (failed). */
export const PHASE_SELECTOR = "0xb1c9fe6e";
export const ON_CURVE = 0;
export const GRADUATED = 2;
export const EXPLORER = "https://www.pharosscan.xyz";

export interface RpcLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockTimestamp?: Hex;
  transactionHash: Hex;
  logIndex: Hex;
  removed?: boolean;
}

export interface Market {
  market: string; // lower-case
  pToken: string;
  symbol: string;
  decimals: number;
  createdBlock: number;
  /** Set once the market reached a phase it never leaves (2 graduated, 3 curve only). */
  finalPhase?: 2 | 3;
  /** Block at which finalPhase was seen; it only applies to blocks at or after this one. */
  finalAt?: number;
}

export interface Trade {
  id: string; // txHash:logIndex
  market: string;
  symbol: string;
  side: "BUY" | "SELL";
  trader: string;
  pros: number; // PROS paid (buy, gross) or received (sell, net)
  tokens: number;
  fee: number;
  price: number; // PROS per pToken, before fees
  block: number;
  time: number; // unix seconds
  tx: string;
}

export function decodeMarketCreated(log: RpcLog) {
  return {
    vault: getAddress(`0x${log.topics[1].slice(26)}`),
    creator: getAddress(`0x${log.topics[2].slice(26)}`),
    pToken: getAddress(`0x${log.topics[3].slice(26)}`),
    market: getAddress(`0x${log.data.slice(26, 66)}`),
  };
}

export function decodeTrade(log: RpcLog, m: Market): Trade {
  const ev = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const a = ev.args as Record<string, bigint | string | boolean>;
  const buy = ev.eventName === "Bought";
  const pros = Number(formatUnits((buy ? a.grossIn : a.netOut) as bigint, 18));
  const curvePros = Number(formatUnits((buy ? a.netIn : a.grossOut) as bigint, 18));
  const tokens = Number(formatUnits((buy ? a.pTokenOut : a.pTokenIn) as bigint, m.decimals));
  return {
    id: `${log.transactionHash}:${Number(BigInt(log.logIndex))}`,
    market: m.market,
    symbol: m.symbol,
    side: buy ? "BUY" : "SELL",
    trader: getAddress(a.trader as string),
    pros,
    tokens,
    fee: Number(formatUnits(a.fee as bigint, 18)),
    price: tokens > 0 ? curvePros / tokens : 0,
    block: Number(BigInt(log.blockNumber)),
    time: log.blockTimestamp ? Number(BigInt(log.blockTimestamp)) : 0,
    tx: log.transactionHash,
  };
}
