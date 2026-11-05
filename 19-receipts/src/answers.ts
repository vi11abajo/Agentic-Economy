// The questions receipts can answer, each as plain lines with fact ids, followed by the sources and the
// "can't tell, because" list. The agent rephrases these for people; the numbers stay tied to their facts.
import { NATIVE, type Holding } from "./adapters.js";
import { plain, REASON_TEXT, type Fact, type Unknown } from "./facts.js";
import { tokenStory, vaultEarnings, type TokenStory } from "./lots.js";
import { USDC } from "./prices.js";
import type { Scan } from "./scan.js";

export interface Answer {
  title: string;
  lines: string[];
  unknowns: Unknown[];
}

const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
/** Facts carry full precision; people get six significant digits, which the checker accepts as rounding. */
export const nice = (value: string) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  if (n === 0) return "0";
  return plain(n, 6);
};

function fact(scan: Scan, id: string | undefined): Fact | undefined {
  return id ? scan.ledger.byId(id) : undefined;
}

function v(scan: Scan, id: string | undefined): string {
  return nice(fact(scan, id)?.value ?? "?");
}

function usd(scan: Scan, id: string | undefined): string {
  const val = Number(fact(scan, id)?.value);
  return `${val < 0 ? "-" : ""}$${nice(String(Math.abs(val)))}`;
}

function holdingLine(scan: Scan, h: Holding, i: number): string {
  const line = scan.saved.valuation.lines[i];
  const where = h.kind === "token" ? "in the wallet" : h.kind === "debt" ? `owed to ${h.protocol}` : h.kind === "in-flight" ? `waiting at ${h.protocol} (${h.note})` : `in ${h.protocol} (${h.kind})`;
  const under = h.underlying?.length ? `, which is ${h.underlying.map((u) => `${v(scan, u.fact)} ${fact(scan, u.fact)?.unit}`).join(" + ")}` : "";
  const ids = [h.facts[0], ...(h.underlying ?? []).map((u) => u.fact)];
  if (line?.usd !== undefined) return `${v(scan, h.facts[0])} ${h.symbol} ${where}${under}: worth ${usd(scan, line.facts[0])} [${[line.facts[0], ...ids].join(", ")}]`;
  return `${v(scan, h.facts[0])} ${h.symbol} ${where}${under}: no USD value (see below) [${ids.join(", ")}]`;
}

const valued = (scan: Scan) => scan.saved.holdings.map((h, i) => ({ h, i, usd: scan.saved.valuation.lines[i]?.usd }));

export function holdings(scan: Scan): Answer {
  const lines = valued(scan).map(({ h, i }) => holdingLine(scan, h, i));
  if (!lines.length) lines.push("Nothing: every token this wallet ever touched reads zero at this block.");
  const t = scan.saved.valuation;
  if (t.totalFact) lines.push("", `Total: ${usd(scan, t.totalFact)}${t.excluded.length ? ` (without ${t.excluded.join(", ")}, which have no on-chain price)` : ""} [${t.totalFact}]`);
  return { title: "What this wallet holds", lines, unknowns: scan.ledger.unknowns() };
}

export function where(scan: Scan, symbol: string): Answer {
  const s = symbol.toLowerCase();
  const hits = valued(scan).filter(({ h }) => h.symbol.toLowerCase() === s || (h.underlying ?? []).some((u) => fact(scan, u.fact)?.unit.toLowerCase() === s));
  const lines = hits.map(({ h, i }) => holdingLine(scan, h, i));
  if (!lines.length) lines.push(`No ${symbol} anywhere receipts can read at this block: not in the wallet, not inside any vault, pool or request it found.`);
  const related = scan.ledger.unknowns().filter((u) => u.reason === "no-adapter" || u.reason === "read-failed" || u.subject.toLowerCase().includes(s));
  return { title: `Where is the ${symbol}`, lines, unknowns: related };
}

export function biggest(scan: Scan): Answer {
  const ranked = valued(scan).filter((x) => x.usd !== undefined && x.h.kind !== "debt").sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  const lines = ranked.slice(0, 3).map(({ h, i }, n) => `${n + 1}. ${holdingLine(scan, h, i)}`);
  if (!lines.length) lines.push("Nothing with a USD value at this block.");
  const unpriced = scan.ledger.unknowns().filter((u) => u.reason === "no-price-route");
  return { title: "Biggest positions by USD value", lines, unknowns: unpriced };
}

export function total(scan: Scan): Answer {
  const t = scan.saved.valuation;
  const lines = t.totalFact ? [`Everything receipts can price: ${usd(scan, t.totalFact)} [${t.totalFact}]`] : ["Nothing could be priced, so there is no total."];
  if (t.excluded.length) lines.push(`Left out because there is no on-chain price for them: ${t.excluded.join(", ")}.`);
  return { title: "Total value", lines, unknowns: scan.ledger.unknowns().filter((u) => u.reason !== "received-not-bought") };
}

export function inflight(scan: Scan): Answer {
  const lines = valued(scan).filter(({ h }) => h.kind === "in-flight").map(({ h, i }) => holdingLine(scan, h, i));
  if (!lines.length) lines.push("No vault request is waiting for this wallet that receipts could read.");
  return { title: "Money in flight (requests a vault has not paid out yet)", lines, unknowns: scan.ledger.unknowns().filter((u) => /request/.test(u.subject)) };
}

export function protocols(scan: Scan): Answer {
  const lines: string[] = ["Where the money sits now:"];
  const byProtocol = new Map<string, string[]>();
  valued(scan).forEach(({ h, i }) => {
    if (h.protocol === "wallet") return;
    byProtocol.set(h.protocol, [...(byProtocol.get(h.protocol) ?? []), holdingLine(scan, h, i)]);
  });
  if (!byProtocol.size) lines.push("- nothing outside the wallet itself");
  for (const [p, ls] of byProtocol) lines.push(`- ${p}:`, ...ls.map((l) => `    ${l}`));
  lines.push("", "Contracts this wallet has called, busiest first (history from the explorer):");
  for (const c of scan.saved.contacts.slice(0, 15)) lines.push(`- ${c.name ?? "unnamed contract"} ${c.address}: ${c.txs} tx, methods ${c.methods.slice(0, 3).join(", ")}`);
  return { title: "Protocols", lines, unknowns: scan.ledger.unknowns().filter((u) => u.reason === "no-adapter" || u.reason === "read-failed") };
}

/** Finds a token by symbol or address among everything the wallet ever touched. */
export function resolveToken(scan: Scan, query: string): string | undefined {
  const q = query.toLowerCase();
  if (q === "pros" || q === "native") return NATIVE;
  if (/^0x[0-9a-f]{40}$/.test(q)) return q;
  const hit = scan.ix.transfers.find((t) => t.token_info?.symbol?.toLowerCase() === q);
  return hit?.token_address.toLowerCase();
}

function storyLines(scan: Scan, s: TokenStory): string[] {
  const lines: string[] = [`${s.symbol} (${s.token}): ${v(scan, s.facts.balance)} held now [${s.facts.balance}]`];
  for (const e of s.events) {
    const f = fact(scan, e.fact)!;
    const what = e.kind === "bought" || e.kind === "sold" ? `${f.label} ${usd(scan, e.fact)}` : `${f.label}`;
    lines.push(`  block ${e.block}: ${what}, tx ${e.tx} [${e.fact}]`);
  }
  if (s.facts.priceNow) lines.push(`  price now: ${usd(scan, s.facts.priceNow)} per ${s.symbol} [${s.facts.priceNow}]`);
  if (s.facts.avgCost) lines.push(`  average price paid: ${usd(scan, s.facts.avgCost)} per ${s.symbol} [${s.facts.avgCost}]`);
  if (s.facts.realized) lines.push(`  realized on sales: ${usd(scan, s.facts.realized)} [${s.facts.realized}]`);
  if (s.facts.unrealized) lines.push(`  ${fact(scan, s.facts.unrealized)!.label}: ${usd(scan, s.facts.unrealized)} [${s.facts.unrealized}]`);
  if (s.facts.received) lines.push(`  ${fact(scan, s.facts.received)!.label}: ${usd(scan, s.facts.received)} [${s.facts.received}]`);
  return lines;
}

export async function pnl(scan: Scan, query?: string): Promise<Answer> {
  const ctx = { line: scan.line, ledger: scan.ledger, pricer: scan.pricer, ix: scan.ix, block: scan.saved.block, wallet: scan.saved.wallet };
  let tokens: string[];
  if (query) {
    const t = resolveToken(scan, query);
    if (!t) return { title: `How ${query} did`, lines: [`This wallet's history has no token called ${query}.`], unknowns: [] };
    if (t === USDC) return { title: "How USDC did", lines: ["USDC is counted as 1 USD, so holding it has no price gain or loss to report."], unknowns: [] };
    if (t === NATIVE) return { title: "How PROS did", lines: ["Native PROS also pays every gas fee and moves through internal calls, so receipts does not compute a profit figure for it; ask for holdings to see what it is worth now."], unknowns: [] };
    tokens = [t];
  } else {
    tokens = scan.saved.holdings.filter((h) => h.kind === "token" && h.asset !== NATIVE && h.asset !== USDC).map((h) => h.asset);
  }
  const lines: string[] = [];
  const unknowns: Unknown[] = [];
  for (const t of tokens) {
    const s = await tokenStory(ctx, t);
    lines.push(...storyLines(scan, s), "");
    unknowns.push(...s.unknowns);
  }
  if (!lines.length) lines.push("No token besides PROS and USDC is held right now.");
  return { title: query ? `How ${query} did` : "How the tokens held now did", lines, unknowns };
}

export async function earning(scan: Scan): Promise<Answer> {
  const ctx = { line: scan.line, ledger: scan.ledger, pricer: scan.pricer, ix: scan.ix, block: scan.saved.block, wallet: scan.saved.wallet };
  const lines: string[] = [];
  const unknowns: Unknown[] = [];
  const vaults = scan.saved.holdings.filter((h) => h.kind === "vault");
  lines.push(vaults.length ? "Vault positions:" : "No vault or staking shares in the wallet at this block.");
  for (const h of vaults) {
    const e = await vaultEarnings(ctx, h);
    if ("reason" in e) {
      unknowns.push(e);
      lines.push(`- ${h.protocol}: no earnings figure (see below)`);
    } else {
      const unit = fact(scan, e.fact)!.unit;
      lines.push(`- ${h.protocol}: earned ${v(scan, e.fact)} ${unit} so far (worth now + taken out - put in) [${[e.fact, ...e.facts].join(", ")}]`);
    }
  }
  const inFlight = scan.saved.holdings.filter((h) => h.kind === "in-flight");
  if (inFlight.length) lines.push("", `${inFlight.length} vault request(s) still waiting to be paid out (receipts inflight shows them).`);
  const tokens = await pnl(scan);
  lines.push("", "Tokens held now:", ...tokens.lines);
  unknowns.push(...tokens.unknowns, ...scan.ledger.unknowns().filter((u) => /request/.test(u.subject)));
  return { title: "What this wallet is earning", lines, unknowns };
}

/** The answer as text: the lines, then every fact they cite, then everything receipts could not tell and why. */
export function render(scan: Scan, a: Answer): string {
  const cited = new Set<string>();
  for (const l of a.lines) for (const m of l.matchAll(/F\d+/g)) cited.add(m[0]);
  if (scan.saved.gaps.length) for (const id of scan.saved.gapFacts ?? []) cited.add(id);
  // A derived figure names its inputs in its call ("F1 x F6"); list those inputs too.
  for (let grew = true; grew; ) {
    grew = false;
    for (const id of [...cited]) {
      for (const m of (scan.ledger.byId(id)?.call ?? "").matchAll(/F\d+/g)) {
        if (!cited.has(m[0])) {
          cited.add(m[0]);
          grew = true;
        }
      }
    }
  }
  const facts = [...cited].map((id) => scan.ledger.byId(id)).filter((f): f is Fact => !!f).sort((x, y) => Number(x.id.slice(1)) - Number(y.id.slice(1)));
  const out = [`${a.title} (wallet ${scan.saved.wallet}, block ${scan.saved.block})`, "", ...a.lines];
  if (facts.length) {
    out.push("", "Sources:");
    for (const f of facts) {
      const where = [f.contract ? `contract ${f.contract}` : "", f.tx ? `tx ${f.tx}` : "", f.call ?? ""].filter(Boolean).join(", ");
      out.push(`  ${f.id}  ${f.label}: ${f.value} ${f.unit} | ${where} | block ${f.block} | ${f.source}`);
    }
  }
  const unknowns = dedupe(a.unknowns);
  if (unknowns.length) {
    out.push("", "What receipts can't tell you, and why:");
    for (const u of unknowns) out.push(`  - ${u.subject}: ${REASON_TEXT[u.reason]}. ${u.details}`);
  }
  if (scan.saved.gaps.length) out.push("", `Explorer note: ${scan.saved.gaps.join("; ")} [${(scan.saved.gapFacts ?? []).join(", ")}]. Each token's history is checked against its balance on chain before any profit figure is given.`);
  return out.join("\n");
}

function dedupe(us: Unknown[]): Unknown[] {
  const seen = new Set<string>();
  return us.filter((u) => {
    const k = `${u.reason}|${u.subject}|${u.details}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export { short };
