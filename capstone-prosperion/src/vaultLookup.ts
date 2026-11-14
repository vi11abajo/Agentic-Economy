// Turns whatever the agent has in hand into a vault address. Every Prosper vault comes with five addresses
// (vault, share token, asset, market, pToken) and a model reading a 68-row list picks the wrong one often
// enough; once it did, vault_picture failed, Hermes paused the whole server and the agent spent six minutes
// reading storage slots by hand. So the vault tools take a name or any of the vault's own addresses.
import { getAddress, isAddress, type Address } from "viem";
import type { VaultListing } from "./prosperApi.js";

export interface VaultHit {
  vault: Address;
  name: string | null;
  /** false: an address Prosper's listing does not know; we still try it, it may be a vault the API missed */
  known: boolean;
}

const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

export function findVault(input: string, list: VaultListing[]): VaultHit {
  const q = input.trim();
  if (isAddress(q)) {
    const hit = list.find((v) => same(v.r25Vault, q) || same(v.share, q) || same(v.market, q) || same(v.pToken, q));
    return hit ? { vault: getAddress(hit.r25Vault), name: hit.vaultName, known: true } : { vault: getAddress(q), name: null, known: false };
  }
  const exact = list.filter((v) => same(v.vaultName, q) || same(v.pVaultSymbol, q));
  const pool = exact.length ? exact : list.filter((v) => v.vaultName.toLowerCase().includes(q.toLowerCase()));
  if (pool.length === 1) return { vault: getAddress(pool[0].r25Vault), name: pool[0].vaultName, known: true };
  if (pool.length === 0) throw new Error(`No Prosper vault is called "${q}". Call list_vaults with a shorter query to see the names.`);
  const names = pool.slice(0, 8).map((v) => `"${v.vaultName}" (${v.r25Vault})`).join(", ");
  throw new Error(`"${q}" fits ${pool.length} vaults: ${names}${pool.length > 8 ? ", ..." : ""}. Pass the full name or the vault address.`);
}
