// Prosper (pros-per.xyz) contracts on Pharos Pacific Mainnet and how to decode their logs.
// Event signatures were recovered by matching keccak topic hashes against real on-chain logs.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import type { PharosMcp } from "@agentic-economy/pharos-mcp";

export const PROSPER_FACTORY: Address = "0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8";
/** ProsperFactory: topics = (vault, creator, pToken), data = (market, buyback). */
export const MARKET_CREATED = "0x6d679d9dcb91cccb2f253f24f8f9b53871eac50c475cb8335cfdd93a32212865";

export const curveEvents = parseAbi([
  "event Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)",
  "event Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)",
]);
export const BOUGHT = toEventSelector(curveEvents[0]);
export const SOLD = toEventSelector(curveEvents[1]);
export const NATIVE = "PROS";
export const EXPLORER = "https://www.pharosscan.xyz";

const viewAbi = parseAbi([
  "function symbol() view returns (string)",
  "function name() view returns (string)",
  "function decimals() view returns (uint8)",
]);

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

export interface MarketRow {
  market: string; // lower-case
  pToken: string;
  vault: string;
  creator: string;
  symbol: string;
  name: string;
  decimals: number;
  createdBlock: number;
  createdTime: number;
}

export interface TradeRow {
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

export function decodeTrade(log: RpcLog, m: MarketRow): TradeRow {
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

/** Reads the pToken's symbol/name/decimals through Pharos Chain MCP (eth_call). */
export async function readToken(mcp: PharosMcp, token: Address) {
  const call = async <T>(fn: "symbol" | "name" | "decimals"): Promise<T> => {
    const { result } = await mcp.call<{ result: Hex }>("eth_call", {
      transaction: { to: token, data: encodeFunctionData({ abi: viewAbi, functionName: fn }) },
      block: "latest",
    });
    return decodeFunctionResult({ abi: viewAbi, functionName: fn, data: result }) as T;
  };
  return { symbol: await call<string>("symbol"), name: await call<string>("name"), decimals: Number(await call<number>("decimals")) };
}
