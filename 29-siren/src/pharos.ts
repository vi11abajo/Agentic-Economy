// Pharos mainnet facts siren needs. Every address here was read back on chain before it went in.
import { createPublicClient, http, parseAbi, type Address, type PublicClient } from "viem";

export const CHAIN_ID = 1672;
export const RPC_URL = process.env.PHAROS_RPC || "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";
export const SOCIALSCAN = "https://api.socialscan.io/pharos-mainnet/v1/explorer";

// eth_getLogs on rpc.pharos.xyz refuses ranges over 1000 blocks
export const LOG_RANGE = 1000n;

export interface Token {
  symbol: string;
  address: Address;
  decimals: number;
}

export const TOKENS: Record<string, Token> = {
  USDC: { symbol: "USDC", address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", decimals: 6 },
  WPROS: { symbol: "WPROS", address: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0", decimals: 18 },
};

// Chainlink PE feed (a SelfManagedFeedsCacheProxy), 18 decimals
export const FEEDS: Record<string, Address> = {
  "PROS/USD": "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466",
};

export const ERC20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

export const FEED_ABI = parseAbi([
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
]);

export const txLink = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (a: string) => `${EXPLORER}/address/${a}`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function pharos(rpc = RPC_URL): PublicClient {
  return createPublicClient({ transport: http(rpc, { retryCount: 2, timeout: 20_000 }) }) as PublicClient;
}
