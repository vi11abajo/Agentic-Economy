// One scan = one wallet at one pinned block: history index, holdings, prices, all facts. Saved to the data home
// so every question afterwards answers from the same block, and the answer checker sees the same fact ids.
import { findHoldings, type Holding } from "./adapters.js";
import { pinBlock } from "./chain.js";
import { indexGaps, loadIndex, type Fetcher, type WalletIndex } from "./explorer.js";
import { Ledger, type Fact, type Unknown } from "./facts.js";
import { groupFlows } from "./flows.js";
import { readJson, writeJson } from "./home.js";
import type { ToolLine } from "./mcp.js";
import { Pricer, type Valuation } from "./prices.js";
import { batch } from "./reads.js";

export interface Contact {
  address: string;
  name?: string;
  txs: number;
  methods: string[];
}

export interface SavedScan {
  wallet: string;
  block: number;
  at: string;
  gaps: string[];
  /** Fact ids for the explorer's served-vs-claimed counts, so an answer can quote them. */
  gapFacts: string[];
  checked: { tokens: number; nonZero: number };
  holdings: Holding[];
  valuation: Omit<Valuation, "lines"> & { lines: { index: number; usd?: number; facts: string[]; unknown?: Unknown }[] };
  contacts: Contact[];
  ledger: { facts: Fact[]; unknowns: Unknown[] };
}

export interface Scan {
  saved: SavedScan;
  ledger: Ledger;
  ix: WalletIndex;
  line: ToolLine;
  pricer: Pricer;
}

const rel = (wallet: string) => `scans/${wallet.toLowerCase()}.json`;

export async function runScan(line: ToolLine, wallet: string, fetcher?: Fetcher): Promise<Scan> {
  const w = wallet.toLowerCase();
  const ix = await loadIndex(w, fetcher);
  const block = await pinBlock(line);
  const ledger = new Ledger();
  const found = await findHoldings({ line, block, ledger, wallet: w }, ix);
  const pricer = new Pricer(line, ledger, ix);
  const valuation = await pricer.value(found.holdings, block);
  const contacts = await whoItTalksTo(line, block, ix);
  const gapFacts: string[] = [];
  for (const [label, got, claimed] of [["transactions", ix.txs.length, ix.totals.txs], ["token transfers", ix.transfers.length, ix.totals.transfers], ["internal transactions", ix.internals.length, ix.totals.internals]] as const) {
    if (got >= claimed) continue;
    gapFacts.push(ledger.add({ label: `${label} the explorer served`, value: String(got), unit: "rows", call: "explorer address history", block, source: "explorer" }).id);
    gapFacts.push(ledger.add({ label: `${label} the explorer says exist`, value: String(claimed), unit: "rows", call: "explorer total", block, source: "explorer" }).id);
  }
  const saved: SavedScan = {
    wallet: w,
    block,
    at: new Date().toISOString(),
    gaps: indexGaps(ix),
    gapFacts,
    checked: found.checked,
    holdings: found.holdings,
    valuation: { ...valuation, lines: valuation.lines.map((l, index) => ({ index, usd: l.usd, facts: l.facts, unknown: l.unknown })) },
    contacts,
    ledger: ledger.toJSON(),
  };
  writeJson(rel(w), saved);
  return { saved, ledger, ix, line, pricer };
}

/** Reopens the last scan of a wallet (or the last scan of any wallet). */
export async function openScan(line: ToolLine, wallet?: string): Promise<Scan | undefined> {
  const w = (wallet ?? readJson<{ wallet?: string }>("last.json", {}).wallet)?.toLowerCase();
  if (!w) return undefined;
  const saved = readJson<SavedScan | null>(rel(w), null);
  if (!saved) return undefined;
  saved.holdings = saved.holdings.map(reviveHolding);
  const ix = readJson<WalletIndex | null>(`wallets/${w}.json`, null);
  if (!ix) return undefined;
  const ledger = Ledger.from(saved.ledger);
  return { saved, ledger, ix, line, pricer: new Pricer(line, ledger, ix) };
}

export function saveScan(scan: Scan): void {
  scan.saved.ledger = scan.ledger.toJSON();
  writeJson(rel(scan.saved.wallet), scan.saved);
  writeJson("last.json", { wallet: scan.saved.wallet });
}

function reviveHolding(h: Holding): Holding {
  return {
    ...h,
    amount: BigInt(h.amount as unknown as string),
    underlying: h.underlying?.map((u) => ({ ...u, amount: BigInt(u.amount as unknown as string) })),
  };
}

/** Every contract the wallet sent transactions to, busiest first, with its name() where it has one. */
async function whoItTalksTo(line: ToolLine, block: number, ix: WalletIndex): Promise<Contact[]> {
  const w = ix.wallet.toLowerCase();
  const byTarget = new Map<string, Contact>();
  for (const f of groupFlows(ix)) {
    if (f.sender !== w || !f.target || f.target === w || f.method === "0x" || !f.method) continue;
    const c = byTarget.get(f.target) ?? { address: f.target, txs: 0, methods: [] };
    c.txs++;
    if (!c.methods.includes(f.method)) c.methods.push(f.method);
    byTarget.set(f.target, c);
  }
  const contacts = [...byTarget.values()].sort((a, b) => b.txs - a.txs).slice(0, 40);
  const names = (await batch({ line, block }, contacts.map((c) => ({ to: c.address, fn: "name" as const })))) as (string | undefined)[];
  contacts.forEach((c, i) => (c.name = names[i]));
  return contacts;
}
