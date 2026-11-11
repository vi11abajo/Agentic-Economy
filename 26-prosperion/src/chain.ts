// One door to Pharos for everything Prosperion reads. Plain RPC, not the Chain MCP: the MCP is the agent's
// second opinion, and it is rate limited to 120 calls a minute, which a block-by-block watcher would eat alone.
import { createPublicClient, defineChain, http, type PublicClient } from "viem";

export const PHAROS_RPC = process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const pharos = defineChain({
  id: 1672,
  name: "Pharos Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [PHAROS_RPC] } },
  blockExplorers: { default: { name: "Pharosscan", url: EXPLORER } },
});

// The public node answers 429 when pushed; viem's retry backs off for us.
export const client: PublicClient = createPublicClient({
  chain: pharos,
  transport: http(PHAROS_RPC, { retryCount: 5, retryDelay: 400, timeout: 20_000 }),
});

export async function blockNow(): Promise<bigint> {
  return client.getBlockNumber({ cacheTime: 0 });
}
