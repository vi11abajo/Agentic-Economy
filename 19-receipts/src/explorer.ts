// The explorer is our table of contents, not our source of truth. It tells us which transactions and tokens a
// wallet ever touched, so we never have to crawl 22 million blocks. Every number we finally show the user is
// then read back from the chain itself (see chain.ts).
import { readJson, writeJson } from "./home.js";

export const EXPLORER_URL = process.env.RECEIPTS_EXPLORER_URL ?? "https://api.socialscan.io/pharos-mainnet/v1/explorer";
const PAGE_SIZE = 100;
const MAX_PAGES = 200; // 20k rows per list; a wallet with more than that is a bot and we say so via indexGaps

export interface ExplorerTx {
  hash: string;
  from_address: string;
  to_address: string | null;
  value: string;
  method_id: string;
  block_number: number;
  block_timestamp?: string;
  receipt_status: number;
}

export interface ExplorerTransfer {
  transaction_hash: string;
  log_index: number;
  from_address: string;
  to_address: string;
  value: string;
  token_address: string;
  block_number: number;
  block_timestamp?: string;
  token_info?: { symbol?: string; name?: string; decimals?: number; type?: string };
}

export interface ExplorerInternal {
  trace_id: string;
  transaction_hash?: string;
  from_address: string;
  to_address: string;
  value: string;
  block_number?: number;
}

export interface WalletIndex {
  wallet: string;
  fetchedAt: string;
  txs: ExplorerTx[];
  transfers: ExplorerTransfer[];
  internals: ExplorerInternal[];
  totals: { txs: number; transfers: number; internals: number };
}

export type Fetcher = (url: string) => Promise<{ total: number; data: unknown[] }>;

const realFetcher: Fetcher = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new ExplorerDown(`${res.status} ${res.statusText} for ${url}`);
  return (await res.json()) as { total: number; data: unknown[] };
};

/** The explorer didn't answer, or answered nonsense. Callers turn this into the "explorer-unreachable" reason. */
export class ExplorerDown extends Error {}

type Kind = "transactions" | "token_transfers" | "internal_transactions";

const keyOf: Record<Kind, (row: any) => string> = {
  transactions: (r: ExplorerTx) => r.hash,
  token_transfers: (r: ExplorerTransfer) => `${r.transaction_hash}:${r.log_index}`,
  internal_transactions: (r: ExplorerInternal) => r.trace_id,
};

/**
 * Pulls one list newest-first, page by page, and stops as soon as it meets a row we already have (or runs out).
 * Returns the merged list, newest first, plus the total the explorer claims.
 */
async function pullList<T>(wallet: string, kind: Kind, known: T[], fetcher: Fetcher): Promise<{ rows: T[]; total: number }> {
  const seen = new Set(known.map(keyOf[kind]));
  const fresh: T[] = [];
  let total = known.length;
  for (let page = 1; page <= MAX_PAGES; page++) {
    let body;
    try {
      body = await fetcher(`${EXPLORER_URL}/address/${wallet}/${kind}?page=${page}&size=${PAGE_SIZE}`);
    } catch (err) {
      if (err instanceof ExplorerDown) throw err;
      throw new ExplorerDown(String((err as Error)?.message ?? err));
    }
    if (!body || !Array.isArray(body.data)) throw new ExplorerDown(`unexpected ${kind} answer for ${wallet}`);
    total = body.total;
    let metOld = false;
    for (const row of body.data as T[]) {
      if (seen.has(keyOf[kind](row))) {
        metOld = true;
        continue;
      }
      seen.add(keyOf[kind](row));
      fresh.push(row);
    }
    if (metOld || body.data.length < PAGE_SIZE || fresh.length + known.length >= total) break;
  }
  return { rows: [...fresh, ...known], total };
}

/** The wallet's whole history as the explorer knows it, refreshed incrementally and cached in the data home. */
export async function loadIndex(wallet: string, fetcher: Fetcher = realFetcher): Promise<WalletIndex> {
  const w = wallet.toLowerCase();
  const rel = `wallets/${w}.json`;
  const cached = readJson<WalletIndex | null>(rel, null);
  const txs = await pullList(w, "transactions", cached?.txs ?? [], fetcher);
  const transfers = await pullList(w, "token_transfers", cached?.transfers ?? [], fetcher);
  const internals = await pullList(w, "internal_transactions", cached?.internals ?? [], fetcher);
  const index: WalletIndex = {
    wallet: w,
    fetchedAt: new Date().toISOString(),
    txs: txs.rows as ExplorerTx[],
    transfers: transfers.rows as ExplorerTransfer[],
    internals: internals.rows as ExplorerInternal[],
    totals: { txs: txs.total, transfers: transfers.total, internals: internals.total },
  };
  writeJson(rel, index);
  return index;
}

/** Lists where we hold fewer rows than the explorer says exist. Empty means the history is complete. */
export function indexGaps(ix: WalletIndex): string[] {
  const gaps: string[] = [];
  const check = (label: string, got: number, total: number) => {
    if (got < total) gaps.push(`${label}: got ${got} of ${total}`);
  };
  check("transactions", ix.txs.length, ix.totals.txs);
  check("token transfers", ix.transfers.length, ix.totals.transfers);
  check("internal transactions", ix.internals.length, ix.totals.internals);
  return gaps;
}
