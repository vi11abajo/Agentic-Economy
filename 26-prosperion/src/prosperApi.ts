// Prosper's own API. Good for names and lists; never the source of a number we state as fact.
// Every address it hands us is re-checked on chain before the agent leans on it (market_check, protocol_map).
import type { Address } from "viem";

export const PROSPER_API = "https://api.pros-per.xyz/api/v1";

export interface VaultListing {
  vaultName: string;
  r25Vault: Address;
  share: Address;
  market: Address;
  pToken: Address;
  pVaultSymbol: string;
  status: string;
  createdAt: string;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${PROSPER_API}${path}`, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Prosper API ${path} answered ${res.status}`);
  return ((await res.json()) as { data: T }).data;
}

export async function listVaults(): Promise<VaultListing[]> {
  // pageSize=100 returns all 68 today in one page; follow hasNext anyway in case it grows.
  const out: VaultListing[] = [];
  for (let page = 1; page < 20; page++) {
    const res = await fetch(`${PROSPER_API}/vaults?pageSize=100&pageNumber=${page}`, { signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { data: { list: VaultListing[] }; meta: { hasNext: boolean } };
    out.push(...j.data.list);
    if (!j.meta.hasNext) break;
  }
  return out;
}

export interface Incentives {
  currentUnlockBps: number;
  navUnlocks: { thresholdBps: number; cumulativeUnlockBps: number }[];
  rewardCap: string;
  totalEligibleShares: string;
}

export const incentives = (vault: Address) => get<Incentives>(`/vaults/${vault}/incentives`);
