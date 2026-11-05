import type { ToolLine } from "./mcp.js";

/** A line copied word for word from a docs page, with the page it came from. */
export interface Quote {
  url: string;
  title: string;
  text: string;
}

export interface DocPage {
  url: string;
  title: string;
  text: string;
}

/** Everything nerd read before touching the chain. Saved to disk so `call` can prove the docs came first. */
export interface Brief {
  key: string;
  subject: string;
  searched: string[];
  pages: DocPage[];
  quotes: Quote[];
  madeAt: number;
}

export interface LookupPlan {
  key: string;
  subject: string;
  /** What we type into searchDocumentation, one search each. */
  searches: string[];
  /** Words a line must contain to be quoted. Hex addresses match in any case, everything else exactly. */
  needles: string[];
  /** How many distinct pages to open with getPage. */
  maxPages?: number;
}

const QUOTE_CAP_PER_PAGE = 10;
const QUOTE_MAX_CHARS = 400;

/** Pulls the "Title: / Link:" pairs out of a searchDocumentation answer, in the order the server ranked them. */
export function hitsFromSearch(answer: string): { title: string; url: string }[] {
  const hits: { title: string; url: string }[] = [];
  let pendingTitle = "";
  for (const raw of answer.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("Title:")) pendingTitle = line.slice(6).trim();
    else if (line.startsWith("Link:")) {
      const url = line.slice(5).trim();
      if (/^https?:\/\//.test(url)) hits.push({ title: pendingTitle, url });
    }
  }
  return hits;
}

/** The lines of a page that mention any needle. Copied as they are (only trimmed), so anyone can find them again. */
export function quotesFrom(page: DocPage, needles: string[]): Quote[] {
  const found: Quote[] = [];
  const seen = new Set<string>();
  for (const raw of page.text.split("\n")) {
    const text = raw.trim();
    if (!text || seen.has(text) || !needles.some((n) => mentions(text, n))) continue;
    seen.add(text);
    found.push({ url: page.url, title: page.title, text: text.length > QUOTE_MAX_CHARS ? text.slice(0, QUOTE_MAX_CHARS) : text });
    if (found.length >= QUOTE_CAP_PER_PAGE) break;
  }
  return found;
}

export function mentions(text: string, needle: string): boolean {
  if (/^0x[0-9a-fA-F]+$/.test(needle)) return text.toLowerCase().includes(needle.toLowerCase());
  return text.includes(needle);
}

/** Search, open the pages the search pointed at, keep the lines that talk about our subject. Docs MCP only. */
export async function readTheDocs(docs: ToolLine, plan: LookupPlan): Promise<Brief> {
  const wanted: { title: string; url: string }[] = [];
  for (const query of plan.searches) {
    const answer = await docs.ask("searchDocumentation", { query });
    for (const hit of hitsFromSearch(answer)) {
      if (!wanted.some((w) => w.url === hit.url)) wanted.push(hit);
    }
  }

  // Open pages in ranked order, but a page that never mentions a needle is not worth a slot: keep going until we
  // have enough pages that do, or run out of hits.
  const maxPages = plan.maxPages ?? 3;
  const pages: DocPage[] = [];
  const quotes: Quote[] = [];
  for (const hit of wanted.slice(0, maxPages * 3)) {
    if (pages.length >= maxPages) break;
    const text = await docs.ask("getPage", { url: hit.url });
    const page: DocPage = { url: hit.url, title: titleOf(text) ?? hit.title, text };
    const lines = quotesFrom(page, plan.needles);
    if (lines.length === 0) continue;
    pages.push(page);
    quotes.push(...lines);
  }
  return { key: plan.key, subject: plan.subject, searched: plan.searches, pages, quotes, madeAt: Date.now() };
}

function titleOf(markdown: string): string | undefined {
  const m = /^#\s+(.+)$/m.exec(markdown);
  return m?.[1]?.trim();
}
