// Atlantic testnet facts both sides use. The USDC here is the one in the docs' token registry; checked on chain
// before it went in: name "USDC", EIP-712 version "2", 6 decimals, DOMAIN_SEPARATOR equal to the one built from
// those values and chain 688689, and an implementation that has transferWithAuthorization (EIP-3009). The other
// "USD Coin" the x402 guide mentions (0xE0BE…) has no transferWithAuthorization, so x402 "exact" can't settle on it.
import { createPublicClient, createWalletClient, defineChain, http, parseAbi, type Account, type Address } from "viem";

export const NETWORK = "eip155:688689" as const;
export const CHAIN_ID = 688689;
export const RPC_URL = process.env.ATLANTIC_RPC || "https://atlantic.dplabs-internal.com";
export const EXPLORER = "https://atlantic.pharosscan.xyz";
export const USDC: Address = "0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B";
export const USDC_DECIMALS = 6;
export const USDC_DOMAIN = { name: "USDC", version: "2" } as const;

export const EIP3009 = parseAbi([
  "function authorizationState(address authorizer, bytes32 nonce) view returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export const atlantic = defineChain({
  id: CHAIN_ID,
  name: "Pharos Atlantic",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "pharosscan", url: EXPLORER } },
});

export const reader = () => createPublicClient({ chain: atlantic, transport: http(RPC_URL, { timeout: 20_000, retryCount: 2 }) });
export const writer = (account: Account) => createWalletClient({ account, chain: atlantic, transport: http(RPC_URL, { timeout: 30_000, retryCount: 0 }) });

export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`;
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const usdc = (atomic: bigint | string) => (Number(atomic) / 10 ** USDC_DECIMALS).toFixed(6).replace(/0{1,4}$/, "");
