// Pharos mainnet, the explorer API and the few contracts sonar reads. Addresses were all read back on chain.
import { createPublicClient, formatUnits, http, parseAbi, type Address, type PublicClient } from "viem";

export const RPC_URL = process.env.PHAROS_RPC || "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";
export const API = "https://api.socialscan.io/pharos-mainnet/v1/explorer";

export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Address;
export const WPROS = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0" as Address;
export const PROS_USD = "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466" as Address; // Chainlink PE feed, 18 decimals
export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as Address;
export const ZERO = "0x0000000000000000000000000000000000000000";

export const ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function getEthBalance(address) view returns (uint256)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
]);

export const txLink = (h: string) => `${EXPLORER}/tx/${h}`;
export const addressLink = (a: string) => `${EXPLORER}/address/${a}`;
export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function pharos(rpc = RPC_URL): PublicClient {
  // the public RPC answers "cu limit exceeded" when hit too fast, so retries back off
  return createPublicClient({ transport: http(rpc, { retryCount: 5, retryDelay: 700, timeout: 20_000 }) }) as PublicClient;
}

export async function prosUsd(client: PublicClient): Promise<{ price: number; updatedAt: number }> {
  const [, answer, , updatedAt] = await client.readContract({ address: PROS_USD, abi: ABI, functionName: "latestRoundData" });
  return { price: Number(formatUnits(answer, 18)), updatedAt: Number(updatedAt) };
}

export type Get = (path: string) => Promise<unknown>;

/** The explorer API, a little slower than it allows, with a couple of retries. */
export function explorer(net: typeof fetch = fetch, pauseMs = 120): Get {
  let last = 0;
  return async (path) => {
    for (let attempt = 0; ; attempt++) {
      const wait = last + pauseMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      let res: Response | undefined;
      let failure: unknown;
      try {
        res = await net(`${API}/${path}`);
        if (res.ok) return await res.json();
      } catch (e) {
        failure = e;
      }
      const again = !res || res.status >= 500 || res.status === 429;
      if (!again || attempt >= 2) throw failure ?? new Error(`explorer API ${path.split("?")[0]}: HTTP ${res!.status}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  };
}
