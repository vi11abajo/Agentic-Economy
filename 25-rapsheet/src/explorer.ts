// The socialscan explorer behind pharosscan is our index of an address's whole life: when it was born, who paid for
// its first gas, what it approved, who it dealt with. Pharos itself can't answer "what did this address ever do" (no
// tx-by-address call, getLogs capped at 1,000 blocks), so the leaders of this task read a few hours of logs and stop.
// We read the index, then check the facts that decide a verdict against the chain (see signals/*).
import { getAddress } from "viem";

export type Hex = `0x${string}`;

export interface Profile {
  address: Hex;
  isContract: boolean;
  name: string | null;
  verified: boolean | null;
  proxy: boolean | null;
  /** The implementation the explorer believes in. It can be stale: the chain slot wins (signals/contract.ts). */
  explorerImpl: Hex | null;
  /** How many verified contracts share this exact bytecode. A clone of verified code isn't a black box. */
  verifiedTwins: number;
  creator: Hex | null;
  creationTx: Hex | null;
  createdAt: number | null;
  firstTx: { hash: Hex; block: number; time: number } | null;
  funding: { from: Hex; value: string; hash: Hex; time: number } | null;
  tags: string[];
}

export interface Tx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  value: string;
  methodId: string;
  block: number;
  time: number;
  ok: boolean;
}

export interface Transfer {
  hash: Hex;
  token: Hex;
  symbol: string;
  from: Hex;
  to: Hex;
  /** Decimal-adjusted, as the explorer prints it. */
  value: string;
  block: number;
  time: number;
}

export interface Listing<T> {
  rows: T[];
  total: number;
  /** True when we stopped before the oldest row (explorer cap or our own page limit). */
  cut: boolean;
}

export interface Explorer {
  profile(a: Hex): Promise<Profile>;
  txs(a: Hex, maxRows?: number): Promise<Listing<Tx>>;
  transfers(a: Hex, maxRows?: number): Promise<Listing<Transfer>>;
}

export const EXPLORER_API = process.env.RAPSHEET_EXPLORER_API ?? "https://api.socialscan.io/pharos-mainnet/v1/explorer";
const PAGE = 100;
export const DEFAULT_ROWS = 3000;

type Row = Record<string, any>;

export const lower = (a: string) => getAddress(a).toLowerCase() as Hex;
const maybe = (a: string | null | undefined) => (a ? lower(a) : null);
const unix = (iso: string | null | undefined) => (iso ? Math.floor(Date.parse(iso) / 1000) : null);

async function getJson(url: string): Promise<any> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return await res.json();
      lastError = new Error(`explorer answered ${res.status} for ${url}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastError;
}

// Newest first. Busy contracts have hundreds of thousands of rows and the explorer shows 10,000 at most, so we stop
// at maxRows and say so: a cut history is reported under "not checked", never silently treated as complete.
async function rows(url: string, maxRows: number): Promise<{ rows: Row[]; total: number; cut: boolean }> {
  const out: Row[] = [];
  for (let page = 1; ; page++) {
    const p = await getJson(`${url}?page=${page}&size=${PAGE}`);
    out.push(...(p.data ?? []));
    const shown = Math.min(p.total ?? 0, p.max_display ?? p.total ?? 0);
    if ((p.data ?? []).length < PAGE || out.length >= shown) return { rows: out, total: p.total ?? out.length, cut: (p.total ?? 0) > shown };
    if (out.length >= maxRows) return { rows: out, total: p.total ?? out.length, cut: true };
  }
}

export function socialscan(api = EXPLORER_API): Explorer {
  return {
    async profile(a) {
      const d = await getJson(`${api}/address/${a.toLowerCase()}/profile`);
      const f = d.funding_transaction;
      return {
        address: lower(d.address ?? a),
        isContract: d.is_contract === true,
        name: d.name ?? null,
        verified: d.is_verified ?? null,
        proxy: d.is_proxy ?? null,
        explorerImpl: maybe(d.implementation_contract),
        verifiedTwins: Array.isArray(d.similar_verified_addresses) ? d.similar_verified_addresses.length : 0,
        creator: maybe(d.contract_creator),
        creationTx: d.transaction_hash ? (String(d.transaction_hash).toLowerCase() as Hex) : null,
        createdAt: unix(d.block_timestamp),
        firstTx: d.first_transaction
          ? { hash: d.first_transaction.transaction_hash.toLowerCase(), block: d.first_transaction.block_number, time: unix(d.first_transaction.block_timestamp)! }
          : null,
        funding: f?.from_address
          ? { from: lower(f.from_address), value: String(f.display_value ?? "0"), hash: f.transaction_hash.toLowerCase(), time: unix(f.block_timestamp)! }
          : null,
        tags: Array.isArray(d.tags) ? d.tags.map((t: any) => String(t?.name ?? t)) : [],
      };
    },
    async txs(a, maxRows = DEFAULT_ROWS) {
      const r = await rows(`${api}/address/${a.toLowerCase()}/transactions`, maxRows);
      return {
        total: r.total,
        cut: r.cut,
        rows: r.rows.map((x) => ({
          hash: x.hash.toLowerCase(),
          from: lower(x.from_address),
          to: maybe(x.to_address),
          value: String(x.value ?? "0"),
          methodId: String(x.method_id ?? "0x").toLowerCase(),
          block: x.block_number,
          time: unix(x.block_timestamp)!,
          ok: x.receipt_status === 1,
        })),
      };
    },
    async transfers(a, maxRows = DEFAULT_ROWS) {
      const r = await rows(`${api}/address/${a.toLowerCase()}/token_transfers`, maxRows);
      return {
        total: r.total,
        cut: r.cut,
        rows: r.rows.map((x) => ({
          hash: x.transaction_hash.toLowerCase(),
          token: lower(x.token_address),
          symbol: String(x.token_info?.symbol ?? "?"),
          from: lower(x.from_address),
          to: lower(x.to_address),
          value: String(x.value ?? "0"),
          block: x.block_number,
          time: unix(x.block_timestamp)!,
        })),
      };
    },
  };
}
