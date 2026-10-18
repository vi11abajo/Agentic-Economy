// Pure Prosper-curve logic: event ABI, decoding, ordering, de-duplication and block windows.
// No I/O here, so it is unit-tested against real logs (see curve.test.ts).
import { decodeEventLog, formatUnits, getAddress, parseAbi, toEventSelector, type Address, type Hex } from "viem";

// Prosper (pros-per.xyz) bonding-curve markets on Pharos Pacific Mainnet. Every buy or sell on a curve emits
// one of these events from the market contract (signatures matched by topic hash against on-chain logs).
export const curveEvents = parseAbi([
  "event Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)",
  "event Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)",
]);
// ProsperFactory emits one event per new market: topics = (vault, creator, pToken), data = (market, buyback).
export const PROSPER_FACTORY = "0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8";
export const MARKET_CREATED_TOPIC = "0x6d679d9dcb91cccb2f253f24f8f9b53871eac50c475cb8335cfdd93a32212865";

export const BOUGHT = toEventSelector(curveEvents[0]);
export const SOLD = toEventSelector(curveEvents[1]);
export const NATIVE = "PROS"; // curves are priced in the native token (paid in, or WPROS/PROS out)
export const QUOTE_DECIMALS = 18;
export const EXPLORER = "https://www.pharosscan.xyz";
export const MAX_LOG_RANGE = 1000n; // Pharos MCP get_logs limit (inclusive)
export const KEEP_SEEN = 5000;

export interface MarketConfig {
  name?: string;
  market: string;
  /** Only report trades of at least this many PROS (optional). */
  minPros?: number;
}
export interface Config {
  intervalSec?: number;
  confirmations?: number;
  markets: MarketConfig[];
}
export interface Market extends MarketConfig {
  market: Address;
  pToken: Address;
  symbol: string;
  decimals: number;
}
export interface State {
  markets: string[];
  nextBlock: string;
  seen: string[];
}
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

export type Trade = ReturnType<typeof decodeTrade>;

export function decodeTrade(log: RpcLog, m: Market) {
  const ev = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
  const a = ev.args as Record<string, bigint | string | boolean>;
  const isBuy = ev.eventName === "Bought";
  const pros = isBuy ? (a.grossIn as bigint) : (a.netOut as bigint);
  const tokens = isBuy ? (a.pTokenOut as bigint) : (a.pTokenIn as bigint);
  const net = isBuy ? (a.netIn as bigint) : (a.grossOut as bigint);
  return {
    side: isBuy ? "BUY" : "SELL",
    token: m.symbol,
    name: m.name,
    market: m.market,
    trader: getAddress(a.trader as string),
    pros: formatUnits(pros, QUOTE_DECIMALS),
    tokens: formatUnits(tokens, m.decimals),
    fee: formatUnits(a.fee as bigint, QUOTE_DECIMALS),
    // Curve price of this trade, before fees: PROS per one pToken.
    price: tokens > 0n ? Number(formatUnits(net, QUOTE_DECIMALS)) / Number(formatUnits(tokens, m.decimals)) : 0,
    block: Number(BigInt(log.blockNumber)),
    time: log.blockTimestamp ? new Date(Number(BigInt(log.blockTimestamp)) * 1000).toISOString() : undefined,
    tx: log.transactionHash,
    url: `${EXPLORER}/tx/${log.transactionHash}`,
  };
}

/** Unique id of a log: the same event can come back in overlapping windows or after a restart. */
export function logId(log: RpcLog): string {
  return `${log.transactionHash}:${Number(BigInt(log.logIndex))}`;
}

/**
 * New trades from one get_logs page, in chain order: skips removed (re-org) logs, logs already in `seen`
 * (and adds the new ones to it), logs of unknown markets and trades below the market's minPros.
 */
export function pickNewTrades(logs: RpcLog[], markets: Map<string, Market>, seen: Set<string>): Trade[] {
  const out: Trade[] = [];
  for (const log of [...logs].sort(byPosition)) {
    if (log.removed) continue;
    const id = logId(log);
    if (seen.has(id)) continue;
    seen.add(id);
    const market = markets.get(log.address.toLowerCase());
    if (!market) continue;
    const trade = decodeTrade(log, market);
    if (market.minPros && Number(trade.pros) < market.minPros) continue;
    out.push(trade);
  }
  return out;
}

/** Last block of the get_logs window that starts at `from` (inclusive range, at most MAX_LOG_RANGE blocks). */
export function windowEnd(from: bigint, safeHead: bigint): bigint {
  return from + MAX_LOG_RANGE - 1n < safeHead ? from + MAX_LOG_RANGE - 1n : safeHead;
}

export function byPosition(a: RpcLog, b: RpcLog): number {
  const d = BigInt(a.blockNumber) - BigInt(b.blockNumber);
  return d !== 0n ? (d < 0n ? -1 : 1) : Number(BigInt(a.logIndex) - BigInt(b.logIndex));
}

export function hex(n: bigint): Hex {
  return `0x${n.toString(16)}`;
}

export function fmt(n: bigint): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

export function num(s: string): string {
  const v = Number(s);
  const digits = v >= 1000 ? 0 : v >= 1 ? 4 : 6;
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function short(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

