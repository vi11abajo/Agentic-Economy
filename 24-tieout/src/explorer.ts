// The explorer is only the index here: it says WHICH transactions touched the wallet. Pharos won't answer
// eth_getLogs for more than 1,000 blocks at a time and has no "transactions by address" call, so without an index a
// week of history would mean 600 log queries per token. Every token amount in the report is then read from the
// transaction receipts, and the tie-out checks the explorer didn't miss anything.
import { getAddress } from "viem";

export type Hex = `0x${string}`;

export interface ExplorerTx {
  hash: Hex;
  from: Hex;
  to: Hex | null;
  /** Native PROS sent with the tx, as the explorer prints it (decimal, 18 places at most). */
  value: string;
  methodId: string;
  /** Method name the explorer decoded, "" when it couldn't. */
  method: string;
  block: number;
  time: number;
  ok: boolean;
}

export interface ExplorerTransfer {
  hash: Hex;
  token: Hex;
  from: Hex;
  to: Hex;
  block: number;
  time: number;
  symbol: string;
  /** The token's full name, used when two assets share a symbol. */
  name: string;
  decimals: number | null;
  standard: string;
}

export interface ExplorerInternal {
  hash: Hex;
  from: Hex;
  to: Hex;
  value: string;
  block: number;
  time: number;
  ok: boolean;
}

export interface History {
  txs: ExplorerTx[];
  transfers: ExplorerTransfer[];
  internals: ExplorerInternal[];
  /** Names the explorer knows for addresses (contract names, labels), lower-case address -> name. */
  names: Map<string, string>;
  /** Contracts among the addresses seen, lower-case. */
  contracts: Set<string>;
  /** True when the explorer stops listing before the wallet's first transaction (it shows 10,000 rows at most). */
  cut: boolean;
}

export interface Explorer {
  /** Everything the explorer lists for the wallet up to (and including) block `until`. */
  history(wallet: Hex, until: number): Promise<History>;
}

export const EXPLORER_API = process.env.TIEOUT_EXPLORER_API ?? "https://api.socialscan.io/pharos-mainnet/v1/explorer";
const PAGE = 100;

type Row = Record<string, any>;
interface Page {
  total: number;
  max_display?: number;
  data: Row[];
}

const addr = (a: string | null | undefined) => (a ? (getAddress(a).toLowerCase() as Hex) : null);
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

async function getJson(url: string): Promise<Page> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.ok) return (await res.json()) as Page;
      lastError = new Error(`explorer answered ${res.status} for ${url}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
  }
  throw lastError;
}

// Pages come newest first. We read every page (the "first contact" check needs the wallet's older history too),
// but rows after `until` are dropped since they're in the future as far as the report is concerned.
async function everyRow(base: string, kind: string): Promise<{ rows: Row[]; cut: boolean }> {
  const rows: Row[] = [];
  for (let page = 1; ; page++) {
    const p = await getJson(`${base}/${kind}?page=${page}&size=${PAGE}`);
    rows.push(...p.data);
    const shown = Math.min(p.total, p.max_display ?? p.total);
    if (p.data.length < PAGE || rows.length >= shown) return { rows, cut: p.total > shown };
  }
}

export function socialscan(api = EXPLORER_API): Explorer {
  return {
    async history(wallet, until) {
      const base = `${api}/address/${wallet.toLowerCase()}`;
      const [t, x, i] = await Promise.all([everyRow(base, "transactions"), everyRow(base, "token_transfers"), everyRow(base, "internal_transactions")]);
      const names = new Map<string, string>();
      const contracts = new Set<string>();
      const learn = (side: Row | null | undefined) => {
        if (!side?.address) return;
        const a = side.address.toLowerCase();
        const name = side.contract?.name || side.name;
        if (name && !names.has(a)) names.set(a, String(name));
        if (side.is_contract) contracts.add(a);
      };
      for (const r of [...t.rows, ...x.rows, ...i.rows]) {
        learn(r.from_addr);
        learn(r.to_addr);
      }
      for (const r of x.rows) if (r.token_info?.symbol) names.set(r.token_address.toLowerCase(), r.token_info.symbol);

      const txs: ExplorerTx[] = t.rows
        .filter((r) => r.block_number <= until)
        .map((r) => ({
          hash: r.hash.toLowerCase(),
          from: addr(r.from_address)!,
          to: addr(r.to_address),
          value: String(r.value ?? "0"),
          methodId: String(r.method_id ?? "0x"),
          method: String(r.method ?? ""),
          block: r.block_number,
          time: unix(r.block_timestamp),
          ok: r.receipt_status === 1,
        }));
      const transfers: ExplorerTransfer[] = x.rows
        .filter((r) => r.block_number <= until)
        .map((r) => ({
          hash: r.transaction_hash.toLowerCase(),
          token: addr(r.token_address)!,
          from: addr(r.from_address)!,
          to: addr(r.to_address)!,
          block: r.block_number,
          time: unix(r.block_timestamp),
          symbol: String(r.token_info?.symbol ?? r.token_symbol ?? "?"),
          name: String(r.token_info?.name ?? r.token_name ?? ""),
          decimals: r.token_info?.decimals ?? null,
          standard: String(r.token_info?.type ?? r.token_type ?? "ERC20"),
        }));
      const internals: ExplorerInternal[] = i.rows
        .filter((r) => r.block_number <= until)
        .map((r) => ({
          hash: r.transaction_hash.toLowerCase(),
          from: addr(r.from_address)!,
          to: addr(r.to_address)!,
          value: String(r.value ?? "0"),
          block: r.block_number,
          time: unix(r.block_timestamp),
          ok: r.status === 1 && !r.error,
        }));
      return { txs, transfers, internals, names, contracts, cut: t.cut || x.cut || i.cut };
    },
  };
}
