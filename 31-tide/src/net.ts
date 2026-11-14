// The two Pharos networks tide knows. Both were checked live on 2026-11-14: mainnet's base fee sat at 10 gwei for
// the whole week before (hourly samples), Atlantic's at 1 gwei over the 1024 blocks checked, and on both eth_gasPrice answers 10 gwei.
import { createPublicClient, createWalletClient, defineChain, http, type Account, type PublicClient, type WalletClient } from "viem";

export interface Network {
  name: "mainnet" | "atlantic";
  chainId: number;
  rpc: string;
  explorer: string;
  blockSeconds: number; // measured 2026-11-14: mainnet 100 blocks in 84 s, Atlantic 1000 blocks in 1938 s
}

export const NETWORKS: Record<Network["name"], Network> = {
  mainnet: { name: "mainnet", chainId: 1672, rpc: process.env.PHAROS_RPC || "https://rpc.pharos.xyz", explorer: "https://www.pharosscan.xyz", blockSeconds: 0.84 },
  atlantic: { name: "atlantic", chainId: 688689, rpc: process.env.ATLANTIC_RPC || "https://atlantic.dplabs-internal.com", explorer: "https://atlantic.pharosscan.xyz", blockSeconds: 1.94 },
};

export const chainOf = (n: Network) =>
  defineChain({ id: n.chainId, name: `Pharos ${n.name}`, nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 }, rpcUrls: { default: { http: [n.rpc] } } });

export function reader(n: Network): PublicClient {
  // the public RPC says "cu limit exceeded" when pushed, so retries back off
  return createPublicClient({ chain: chainOf(n), transport: http(n.rpc, { retryCount: 5, retryDelay: 700, timeout: 20_000 }) }) as PublicClient;
}

export function writer(n: Network, account: Account): WalletClient {
  return createWalletClient({ account, chain: chainOf(n), transport: http(n.rpc, { retryCount: 2, timeout: 30_000 }) });
}

export const txUrl = (n: Network, h: string) => `${n.explorer}/tx/${h}`;
