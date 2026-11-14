// A whale's recent history from the explorer API, folded into one Move per transaction: what came in, what went
// out, from and to whom. Three lists make it up: transactions (PROS sent with a call), internal transactions (PROS
// paid out by contracts) and token transfers. Grouping them by tx hash is what lets sonar tell a swap from a
// plain transfer.
import type { Get } from "./pharos.js";

export interface Party {
  address: string;
  contract: boolean;
  name?: string; // the explorer's name for it, when it has one
}

export interface Leg {
  dir: "in" | "out";
  symbol: string;
  token: string | null; // null for native PROS
  amount: number;
  party: Party;
  explorerPrice?: number; // the explorer's USD price for tokens sonar has no feed for
}

export interface Move {
  hash: string;
  block: number;
  time: string;
  legs: Leg[];
  called?: Party; // what the whale's own tx went to, when the whale sent it
}

interface Addr {
  address: string;
  is_contract?: boolean;
  name?: string | null;
  contract?: { name?: string | null } | null;
}

const party = (address: string, a?: Addr | null): Party => ({
  address: address.toLowerCase(),
  contract: !!a?.is_contract,
  name: a?.name || a?.contract?.name || undefined,
});

interface Page<T> {
  data?: T[];
}

/** Rows newer than `since`, newest first, at most `maxPages` pages of 100. */
async function rows<T extends { block_timestamp: string }>(get: Get, path: string, since: string, maxPages: number): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const data = ((await get(`${path}?page=${page}&size=100`)) as Page<T>).data ?? [];
    for (const r of data) if (r.block_timestamp >= since) out.push(r);
    if (data.length < 100 || data.at(-1)!.block_timestamp < since) break;
  }
  return out;
}

interface TxRow {
  hash: string;
  from_address: string;
  to_address: string | null;
  value: string;
  block_number: number;
  block_timestamp: string;
  receipt_status: number;
  from_addr?: Addr;
  to_addr?: Addr | null;
}

interface InternalRow {
  transaction_hash: string;
  from_address: string;
  to_address: string;
  value: string;
  status: number;
  block_number: number;
  block_timestamp: string;
  from_addr?: Addr;
  to_addr?: Addr;
}

interface TransferRow {
  transaction_hash: string;
  log_index: number;
  from_address: string;
  to_address: string;
  value: string;
  token_address: string;
  block_number: number;
  block_timestamp: string;
  token_info?: { symbol?: string; type?: string; extra_info?: { price?: string | null } | null } | null;
  from_addr?: Addr;
  to_addr?: Addr;
}

export async function history(get: Get, whale: string, since: string, maxPages = 10): Promise<Move[]> {
  const me = whale.toLowerCase();
  const base = `address/${me}`;
  const [txs, internals, transfers] = await Promise.all([
    rows<TxRow>(get, `${base}/transactions`, since, maxPages),
    rows<InternalRow>(get, `${base}/internal_transactions`, since, maxPages),
    rows<TransferRow>(get, `${base}/token_transfers`, since, maxPages),
  ]);
  const moves = new Map<string, Move>();
  const move = (hash: string, block: number, time: string) => {
    const key = hash.toLowerCase();
    if (!moves.has(key)) moves.set(key, { hash: key, block, time: new Date(time).toISOString(), legs: [] });
    return moves.get(key)!;
  };
  const leg = (m: Move, from: string, to: string, l: Omit<Leg, "dir" | "party">, fromA?: Addr | null, toA?: Addr | null) => {
    const f = from.toLowerCase();
    const t = to.toLowerCase();
    if (f === t) return; // to itself
    if (f === me) m.legs.push({ ...l, dir: "out", party: party(t, toA) });
    else if (t === me) m.legs.push({ ...l, dir: "in", party: party(f, fromA) });
  };

  for (const t of txs) {
    if (t.receipt_status !== 1) continue;
    const m = move(t.hash, t.block_number, t.block_timestamp);
    if (t.from_address.toLowerCase() === me && t.to_address) m.called = party(t.to_address, t.to_addr);
    if (Number(t.value) > 0 && t.to_address) leg(m, t.from_address, t.to_address, { symbol: "PROS", token: null, amount: Number(t.value) }, t.from_addr, t.to_addr);
  }
  for (const t of internals) {
    if (t.status !== 1 || !(Number(t.value) > 0)) continue;
    leg(move(t.transaction_hash, t.block_number, t.block_timestamp), t.from_address, t.to_address, { symbol: "PROS", token: null, amount: Number(t.value) }, t.from_addr, t.to_addr);
  }
  for (const t of transfers) {
    if (t.token_info?.type && t.token_info.type !== "ERC20") continue; // NFTs carry no amount worth pricing
    const price = Number(t.token_info?.extra_info?.price);
    leg(
      move(t.transaction_hash, t.block_number, t.block_timestamp),
      t.from_address,
      t.to_address,
      { symbol: t.token_info?.symbol || t.token_address.slice(0, 10), token: t.token_address.toLowerCase(), amount: Number(t.value), explorerPrice: Number.isFinite(price) && price > 0 ? price : undefined },
      t.from_addr,
      t.to_addr,
    );
  }
  return [...moves.values()].filter((m) => m.legs.length > 0).sort((a, b) => b.block - a.block);
}
