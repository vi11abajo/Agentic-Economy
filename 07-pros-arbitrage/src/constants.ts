// Pharos Pacific Mainnet addresses prosArbitrage reads. Faroswap's V3 factory comes from the Faroswap web app's
// contract list for chain 1672; the Chainlink feeds from docs.pharos.xyz (oracles/chainlink-pe). All checked live.
import type { Address } from "viem";

export const CHAIN_ID = 1672;
export const RPC_URL = "https://rpc.pharos.xyz";

export const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";
export const USDC: Address = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
/** Storage slot of the balances mapping, used to give the simulator its input tokens (checked against balanceOf). */
export const BALANCE_SLOT: Record<string, number> = { [WPROS.toLowerCase()]: 3, [USDC.toLowerCase()]: 9 };

export const FAROSWAP_V3_FACTORY: Address = "0x2c90CcB0b989afA2433F499698451a25744A552b";
export const FEE_TIERS = [100, 500, 3000, 10000] as const; // hundredths of a bip: 100 = 0.01%

export const FEEDS = {
  "PROS/USD": "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466",
  "USDC/USD": "0x3f882C4F2836b1e5C5278ff2B9FccE2502A35C5d",
  "USDT/USD": "0x525D92D6Caa35060B4D5e3deDa6F52BdA3804618",
} as const satisfies Record<string, Address>;
/** Older than this (the feeds' heartbeat is 1 hour) and a price is not trusted. */
export const MAX_FEED_AGE_SEC = 2 * 3600;

/** The throwaway address the simulator code is put at for an eth_call. Nothing lives there. */
export const SIMULATOR_AT: Address = "0x5157000000000000000000000000000000005157";
