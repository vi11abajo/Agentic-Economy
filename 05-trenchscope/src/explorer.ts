// Pharosscan's own API (api.socialscan.io), the one the explorer site calls for a token's Holders tab.
// Balances match balanceOf on chain; the list is what we can't get from the chain without the whole history.
import { EXPLORER_API } from "./prosper.js";

export interface Holder {
  address: string; // lowercase
  balance: number; // in tokens (the API returns decimals already applied)
  isContract: boolean;
  createdBlock?: number; // for contracts: the block they were deployed in
}

export interface TokenTransfer {
  tx: string;
  from: string;
  to: string;
  value: number;
  block: number;
}

const api = () => process.env.TRENCHSCOPE_EXPLORER_API || EXPLORER_API;

async function getJson(path: string, tries = 3): Promise<unknown> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(`${api()}${path}`, { signal: AbortSignal.timeout(15_000) });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      last = `${res.status} ${text.slice(0, 80)}`;
    } catch (e) {
      last = (e as Error).message;
    }
    await new Promise((r) => setTimeout(r, 1500 * (i + 1)));
  }
  throw new Error(`explorer unavailable (${last.trim()})`);
}

interface RawHolder {
  wallet_address: string;
  balance: string;
  wallet_address_is_contract: boolean;
  addr?: { contract?: { block_number?: number } | null };
}

export async function holders(token: string): Promise<{ holders: Holder[] }> {
  const out: Holder[] = [];
  for (let page = 1; page <= 20; page++) {
    const r = (await getJson(`/v2/explorer/token/${token}/top_holders?page=${page}&size=1000`)) as { total: number; data: RawHolder[] };
    for (const h of r.data) {
      out.push({
        address: h.wallet_address.toLowerCase(),
        balance: Number(h.balance),
        isContract: h.wallet_address_is_contract,
        createdBlock: h.addr?.contract?.block_number ?? undefined,
      });
    }
    if (out.length >= r.total || r.data.length === 0) break;
  }
  return { holders: out };
}

interface RawTransfer {
  transaction_hash: string;
  from_address: string;
  to_address: string;
  value: string;
  block_number: number;
}

/** All transfers of a token, newest first. Curve tokens are young, so this is a page or two. */
export async function transfers(token: string): Promise<TokenTransfer[]> {
  const out: TokenTransfer[] = [];
  for (let page = 1; page <= 10; page++) {
    const r = (await getJson(`/v1/explorer/token/${token}/token_transfers?page=${page}&size=1000`)) as { total: number; data: RawTransfer[] };
    for (const t of r.data) {
      out.push({ tx: t.transaction_hash, from: t.from_address.toLowerCase(), to: t.to_address.toLowerCase(), value: Number(t.value), block: t.block_number });
    }
    if (out.length >= r.total || r.data.length === 0) break;
  }
  return out;
}
