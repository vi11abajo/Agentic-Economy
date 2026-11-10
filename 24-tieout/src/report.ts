// Puts the whole report together: period -> blocks, explorer index -> receipts -> entries, totals per category,
// the tie-out, the open approvals and the short list of transactions worth a second look.
import { getAddress } from "viem";
import type { Chain } from "./chain.js";
import type { Explorer, Hex, History } from "./explorer.js";
import { CATEGORY_ORDER, NATIVE, buildEntries, periodHashes, type Category, type Entry } from "./ledger.js";
import { lastBlockAtOrBefore, type Period } from "./period.js";
import { tieOut, type AssetLine } from "./tieout.js";

export interface AssetInfo {
  symbol: string;
  decimals: number;
  /** What the report prints: the symbol, plus a short address when two assets share a symbol. */
  label: string;
}

export interface CategoryTotal {
  category: Category;
  count: number;
  fees: bigint;
  /** asset -> how much came in and went out in this category */
  moved: Map<string, { in: bigint; out: bigint }>;
}

export interface OpenApproval {
  token: Hex;
  spender: Hex;
  hash: Hex;
  time: number;
  given: bigint;
  /** allowance read at the closing block (null if the token wouldn't say) */
  left: bigint | null;
}

export type NotableKind = "gap" | "failed" | "unlimited" | "still_open" | "new_counterparty" | "new_contract" | "largest_out" | "largest_in";

export interface Notable {
  kind: NotableKind;
  why: string;
  hash?: Hex;
  address?: Hex;
}

export interface Report {
  wallet: Hex;
  period: Period;
  openBlock: bigint;
  closeBlock: bigint;
  openBlockTime: number;
  closeBlockTime: number;
  assets: Map<string, AssetInfo>;
  entries: Entry[];
  totals: CategoryTotal[];
  books: AssetLine[];
  approvals: OpenApproval[];
  notables: Notable[];
  names: Map<string, string>;
  historyCut: boolean;
}

export const UNLIMITED = 2n ** 255n;
const MAX_PER_KIND = 5;

export const short = (a: string) => `${getAddress(a).slice(0, 6)}…${getAddress(a).slice(-4)}`;
// A token contract goes by the label the report gives the asset ("Wrapped PROS", not the bare "PROS" the explorer
// has for it), anything else by the explorer's name, or by its short address.
export const nameOf = (r: Pick<Report, "names" | "wallet"> & Partial<Pick<Report, "assets">>, a: string) =>
  a.toLowerCase() === r.wallet.toLowerCase() ? "this wallet" : r.assets?.get(a.toLowerCase())?.label ?? r.names.get(a.toLowerCase()) ?? short(a);

export interface Progress {
  (step: string): void;
}

export async function buildReport(chain: Chain, explorer: Explorer, wallet: Hex, period: Period, say: Progress = () => {}): Promise<Report> {
  const me = wallet.toLowerCase() as Hex;
  say("finding the blocks for the period");
  const head = await chain.head();
  if (period.from > (await chain.blockTime(head))) throw new Error("the period starts after the newest block: nothing has happened yet");
  const openBlock = await lastBlockAtOrBefore(period.from - 1, head, (n) => chain.blockTime(n));
  const closeBlock = await lastBlockAtOrBefore(period.to, head, (n) => chain.blockTime(n));
  const [openBlockTime, closeBlockTime] = await Promise.all([chain.blockTime(openBlock), chain.blockTime(closeBlock)]);

  say("reading the wallet's history from the explorer");
  const history = await explorer.history(me, Number(closeBlock));
  const hashes = periodHashes(history, Number(openBlock), Number(closeBlock));
  say(`reading ${hashes.length} receipts from Pharos`);
  const receipts = await chain.receipts(hashes);
  const entries = buildEntries(me, history, receipts, hashes);

  const assets = await describeAssets(chain, history, entries);
  say(`checking ${assets.size} balances at blocks ${openBlock} and ${closeBlock}`);
  const books = (await tieOut(chain, me, entries, [...assets.keys()], openBlock, closeBlock)).filter(
    (l) => l.opening !== 0n || l.closing !== 0n || l.in !== 0n || l.out !== 0n || l.fees !== 0n,
  );

  say("checking which approvals are still open");
  const approvals = await openApprovals(chain, me, entries, closeBlock);
  const report: Report = {
    wallet: getAddress(wallet),
    period,
    openBlock,
    closeBlock,
    openBlockTime,
    closeBlockTime,
    assets,
    entries,
    totals: totalsOf(entries),
    books,
    approvals,
    notables: [],
    names: history.names,
    historyCut: history.cut,
  };
  report.notables = notablesOf(report, history);
  return report;
}

// Every ERC20 the wallet ever held up to the closing block goes into the tie-out, not only the ones that moved in the
// period: a balance that changes with no transfer at all is exactly the kind of thing the report should catch.
async function describeAssets(chain: Chain, h: History, entries: Entry[]): Promise<Map<string, AssetInfo>> {
  const found = new Map<string, { symbol: string; name: string; decimals: number | null }>();
  found.set(NATIVE, { symbol: "PROS", name: "PROS", decimals: 18 });
  for (const t of h.transfers) if (t.standard === "ERC20" && !found.has(t.token)) found.set(t.token, { symbol: t.symbol, name: t.name, decimals: t.decimals });
  for (const e of entries) for (const f of e.flows) if (!found.has(f.asset)) found.set(f.asset, { symbol: "?", name: "", decimals: null });
  for (const [asset, info] of found) {
    if (info.decimals !== null && info.symbol !== "?") continue;
    const onChain = await chain.tokenInfo(asset as Hex);
    found.set(asset, { symbol: onChain?.symbol ?? info.symbol, name: info.name, decimals: onChain?.decimals ?? info.decimals ?? 18 });
  }
  const count = (key: (v: { symbol: string; name: string }) => string) => {
    const m = new Map<string, number>();
    for (const v of found.values()) m.set(key(v), (m.get(key(v)) ?? 0) + 1);
    return (v: { symbol: string; name: string }) => (m.get(key(v)) ?? 0) > 1;
  };
  const symbolClash = count((v) => v.symbol);
  const nameClash = count((v) => v.name);
  const out = new Map<string, AssetInfo>();
  for (const [asset, v] of found) {
    // Native PROS keeps its name. A token wearing the same symbol (Wrapped PROS) goes by its full name, and when even
    // the names repeat (ten pools all called "Uniswap V2") only the address tells them apart.
    let label = v.symbol;
    if (asset !== NATIVE && symbolClash(v)) label = v.name && v.name !== v.symbol && !nameClash(v) ? v.name : `${v.symbol} ${short(asset)}`;
    out.set(asset, { symbol: v.symbol, decimals: v.decimals ?? 18, label });
  }
  return out;
}

export function totalsOf(entries: Entry[]): CategoryTotal[] {
  return CATEGORY_ORDER.map((category) => {
    const mine = entries.filter((e) => e.category === category);
    const moved = new Map<string, { in: bigint; out: bigint }>();
    for (const e of mine)
      for (const f of e.flows) {
        const m = moved.get(f.asset) ?? { in: 0n, out: 0n };
        m[f.dir] += f.amount;
        moved.set(f.asset, m);
      }
    return { category, count: mine.length, fees: mine.reduce((s, e) => s + e.fee, 0n), moved };
  });
}

async function openApprovals(chain: Chain, me: Hex, entries: Entry[], closeBlock: bigint): Promise<OpenApproval[]> {
  // the last approval per token and spender is the one that counts
  const latest = new Map<string, OpenApproval>();
  for (const e of entries)
    for (const a of e.approvals) latest.set(`${a.token}:${a.spender}`, { token: a.token, spender: a.spender, hash: e.hash, time: e.time, given: a.amount, left: null });
  const list = [...latest.values()];
  await Promise.all(list.map(async (a) => (a.left = await chain.allowance(a.token, me, a.spender, closeBlock))));
  return list;
}

function notablesOf(r: Report, h: History): Notable[] {
  const out: Notable[] = [];
  const label = (asset: string) => r.assets.get(asset)?.label ?? asset;
  const amount = (asset: string, v: bigint) => `${formatAmount(v, r.assets.get(asset)?.decimals ?? 18)} ${label(asset)}`;
  const capped = (kind: NotableKind, items: Notable[]) => {
    out.push(...items.slice(0, MAX_PER_KIND));
    if (items.length > MAX_PER_KIND) out.push({ kind, why: `and ${items.length - MAX_PER_KIND} more like that (all in the CSV)` });
  };

  for (const l of r.books)
    if (l.gap === null) out.push({ kind: "gap", why: `${label(l.asset)}: the chain wouldn't give the closing balance, so this one can't be checked` });
    else if (l.gap !== 0n) {
      const size = amount(l.asset, l.gap < 0n ? -l.gap : l.gap);
      // Lending-pool debt tokens are named that way on purpose ("variableDebtUSDC"); their balance is what is owed.
      const debt = /debt/i.test(r.assets.get(l.asset)?.symbol ?? "");
      out.push({
        kind: "gap",
        why: debt
          ? `${label(l.asset)} doesn't tie: it looks like a lending debt token, and what the wallet owes ${l.gap > 0n ? "grew" : "shrank"} by ${size} with no transaction, which is how borrow interest shows up.`
          : `${label(l.asset)} doesn't tie: the closing balance is ${l.gap > 0n ? "higher" : "lower"} than the transactions explain by ${size}. Something moved it without a transfer the explorer lists (interest, a rebase, or a missed transaction).`,
        address: l.asset === NATIVE ? undefined : (l.asset as Hex),
      });
    }

  capped(
    "failed",
    r.entries.filter((e) => e.category === "failed").map((e) => ({ kind: "failed" as const, hash: e.hash, why: `failed${e.method ? ` (${e.method})` : ""}: nothing happened, but ${amount(NATIVE, e.fee)} went on gas` })),
  );

  for (const a of r.approvals) {
    const who = nameOf(r, a.spender);
    if (a.given >= UNLIMITED) out.push({ kind: "unlimited", hash: a.hash, why: `unlimited ${label(a.token)} approval to ${who}: it can move every ${label(a.token)} this wallet ever holds` });
    if (a.left && a.left > 0n)
      out.push({ kind: "still_open", hash: a.hash, why: `${label(a.token)} approval to ${who} is still open at the end of the period (${a.left >= UNLIMITED ? "unlimited" : amount(a.token, a.left)} left)` });
  }

  // First contact: compliance cares about money going to an address the wallet never dealt with before.
  if (!r.historyCut) {
    const known = new Set<string>();
    for (const row of [...h.txs, ...h.transfers, ...h.internals]) {
      if (row.block > Number(r.openBlock)) continue;
      known.add(row.from);
      if (row.to) known.add(row.to);
    }
    const people: Notable[] = [];
    const contracts: Notable[] = [];
    for (const e of r.entries) {
      if (e.category === "transfer_out")
        for (const f of e.flows) {
          if (f.dir !== "out" || known.has(f.counterparty)) continue;
          known.add(f.counterparty);
          people.push({ kind: "new_counterparty", hash: e.hash, address: f.counterparty, why: `first payment ever to ${nameOf(r, f.counterparty)}: ${amount(f.asset, f.amount)}` });
        }
      if ((e.category === "contract" || e.category === "swap" || e.category === "approval") && e.mine && e.target && !known.has(e.target)) {
        known.add(e.target);
        contracts.push({ kind: "new_contract", hash: e.hash, address: e.target, why: `first call to ${nameOf(r, e.target)}${e.method ? ` (${e.method})` : ""}` });
      }
    }
    capped("new_counterparty", people);
    capped("new_contract", contracts);
  }

  // The biggest single movement per asset, when there was more than one to compare.
  for (const dir of ["out", "in"] as const) {
    const perAsset = new Map<string, { hash: Hex; total: bigint; n: number }>();
    for (const e of r.entries) {
      const sums = new Map<string, bigint>();
      for (const f of e.flows) if (f.dir === dir) sums.set(f.asset, (sums.get(f.asset) ?? 0n) + f.amount);
      for (const [asset, total] of sums) {
        const best = perAsset.get(asset);
        if (!best) perAsset.set(asset, { hash: e.hash, total, n: 1 });
        else {
          best.n++;
          if (total > best.total) Object.assign(best, { hash: e.hash, total });
        }
      }
    }
    for (const [asset, best] of perAsset)
      if (best.n > 1)
        out.push({
          kind: dir === "out" ? "largest_out" : "largest_in",
          hash: best.hash,
          why: `largest ${dir === "out" ? "outgoing" : "incoming"} ${label(asset)} in the period: ${amount(asset, best.total)} (of ${best.n})`,
        });
  }
  return out;
}

/** 1234500000 with 6 decimals -> "1,234.5". Never rounds: an audit report shows every unit. */
export function formatAmount(v: bigint, decimals: number): string {
  const neg = v < 0n;
  const s = (neg ? -v : v).toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + whole + (frac ? "." + frac : "");
}
