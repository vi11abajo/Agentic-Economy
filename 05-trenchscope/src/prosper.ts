// Prosper (pros-per.xyz) bonding curves on Pharos Pacific Mainnet: addresses and ABIs.
// The contracts aren't verified on the explorer. Function names come from the Prosper web app bundle
// (app.pros-per.xyz) and were checked with real calls; the two unnamed getters are noted below.
import { getAddress, parseAbi, type Address } from "viem";

export const CHAIN_ID = 1672;
export const RPC_URL = "https://rpc.pharos.xyz";
export const EXPLORER_API = "https://api.socialscan.io/pharos-mainnet";
export const EXPLORER = "https://www.pharosscan.xyz";

/** Every Prosper buy and sell goes through this router (it shows up as `router` in Bought/Sold). */
export const ROUTER: Address = "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5";
export const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";
/** Chainlink PROS/USD on Pacific Mainnet (docs.pharos.xyz, oracles/chainlink-pe). */
export const PROS_USD_FEED: Address = "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466";
/** The feed's heartbeat is 3600 s. Older than this and we don't trust the USD numbers. */
export const MAX_FEED_AGE_SEC = 2 * 3600;

export const marketAbi = parseAbi([
  "function pToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function startedAt() view returns (uint256)",
  "function endsAt() view returns (uint256)",
  "function migrationEscrow() view returns (address)",
  "function quoteBuy(uint256 grossAmountIn) view returns (uint256 usedGross, uint256 fee, uint256 netAmountIn, uint256 pTokenOut)",
  "function quoteSell(uint256 pTokenIn) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
]);

/** Unnamed getter on every market we checked: the PROS the curve has to raise to graduate (20,000). */
export const GRADUATION_TARGET_SELECTOR = "0xf074a48f";

export const routerAbi = parseAbi([
  "function buyInnerNative(address market, uint256 minPTokenOut, uint256 deadline) payable returns (uint256 pTokenOut, uint256 nativeUsed)",
  "function sellInner(address market, uint256 pTokenIn, uint256 minOut, uint256 deadline, bool nativeOut) returns (uint256 amountOut)",
]);

export const curveEvents = parseAbi([
  "event Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)",
  "event Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)",
]);

export const erc20Abi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);

export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const ZERO = "0x0000000000000000000000000000000000000000";

export interface CreationTransfer {
  from: string;
  to: string;
}

/**
 * Prosper splits a new token in the market's creation transaction: 1B is minted to the factory, which sends
 * 73% to the market, 20% to the migration escrow and 7% to a Prosper contract. Those wallets belong to the
 * protocol, not to a trader, so they don't count as holders. We read the split from the token's own Transfer
 * logs in that block instead of hard-coding addresses: whoever got the mint, and everyone it paid out to.
 */
export function protocolWallets(transfers: CreationTransfer[]): Set<string> {
  const minted = transfers.filter((t) => t.from.toLowerCase() === ZERO).map((t) => t.to.toLowerCase());
  const out = new Set<string>(minted);
  for (const t of transfers) if (minted.includes(t.from.toLowerCase())) out.add(t.to.toLowerCase());
  return out;
}

export function short(addr: string): string {
  const a = getAddress(addr);
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}
