// Pharos mainnet facts both sides use: the network id x402 names it by, USDC (EIP-3009, checked on chain:
// name "USDC", version "2", authorizationState exists) and the event its transferWithAuthorization emits.
import { parseAbi, type Address } from "viem";

export const NETWORK = "eip155:1672" as const;
export const CHAIN_ID = 1672;
export const RPC_URL = process.env.TABKEEPER_RPC || "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";
export const USDC: Address = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
export const USDC_DECIMALS = 6;
/** EIP-712 domain of Pharos USDC, which the buyer signs the transfer authorization against. */
export const USDC_DOMAIN = { name: "USDC", version: "2" } as const;

export const EIP3009 = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
