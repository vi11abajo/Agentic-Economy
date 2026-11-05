import type { DocPage, Quote } from "./docs.js";

/**
 * A promise the docs make, pulled out of the page text at run time. Nothing in here is typed in by hand: if the
 * docs change tomorrow, so do these values, and the verdicts follow. `quote` is the exact line it came from.
 */
export interface Fact<T = string> {
  value: T;
  quote: Quote;
}

/** Finds the first line (on any page) where `pattern` matches and returns capture group 1 with that line. */
function pluck(pages: DocPage[], pattern: RegExp, urlHint?: string): Fact | undefined {
  const ordered = urlHint ? [...pages].sort((a, b) => Number(b.url.includes(urlHint)) - Number(a.url.includes(urlHint))) : pages;
  for (const page of ordered) {
    for (const raw of page.text.split("\n")) {
      const m = pattern.exec(raw);
      if (m?.[1] !== undefined) return { value: m[1], quote: { url: page.url, title: page.title, text: raw.trim() } };
    }
  }
  return undefined;
}

function pluckAll(pages: DocPage[], pattern: RegExp, urlHint: string): Fact[] {
  const page = pages.find((p) => p.url.includes(urlHint));
  if (!page) return [];
  const out: Fact[] = [];
  for (const raw of page.text.split("\n")) {
    const m = pattern.exec(raw);
    if (m?.[1] !== undefined) out.push({ value: m[1], quote: { url: page.url, title: page.title, text: raw.trim() } });
  }
  return out;
}

// ---------------------------------------------------------------- x402

export interface X402Facts {
  token?: Fact;
  tokenName?: Fact;
  version?: Fact;
  chainId?: Fact;
  decimals?: Fact;
  /** The worked example in the server code: "(e.g., 0.01 → "10000")". value = "0.01", extra in exampleUnits. */
  example?: Fact;
  exampleUnits?: string;
  prices: Fact[];
}

const MAINNET_PAGE = "x402-pacific-mainnet";

export function x402Facts(pages: DocPage[]): X402Facts {
  const example = pluck(pages, /e\.g\.,\s*([\d.]+)\s*→\s*"\d+"/, MAINNET_PAGE);
  const units = example ? /→\s*"(\d+)"/.exec(example.quote.text)?.[1] : undefined;
  return {
    token: pluck(pages, /USDC token address \(`(0x[0-9a-fA-F]{40})`\)/, MAINNET_PAGE),
    tokenName: pluck(pages, /USDC_NAME\s*\|\|\s*"([^"]+)"/, MAINNET_PAGE),
    version: pluck(pages, /^\s*version:\s*"([^"]+)"/, MAINNET_PAGE),
    chainId: pluck(pages, /"eip155:(\d+)"/, MAINNET_PAGE),
    decimals: pluck(pages, /\((\d+) decimals precision\)/, MAINNET_PAGE),
    example,
    exampleUnits: units,
    prices: pluckAll(pages, /^\s*price:\s*"([\d.]+)"/, MAINNET_PAGE),
  };
}

// ---------------------------------------------------------------- CCTP

export interface HeaderField {
  name: string;
  offset: number;
  type: string;
  /** Byte length, or undefined for the dynamic tail (messageBody). */
  length?: number;
  description: string;
  quote: Quote;
}

export interface CctpFacts {
  transmitter?: Fact;
  localDomain?: Fact;
  messenger?: Fact;
  finalizedAt?: Fact;
  version?: Fact;
  nonceNote?: Quote;
  header: HeaderField[];
}

const CCTP_PAGE = "circle-cctp";

/** The first `| **Pharos** | <domain> | ... 0x... |` row under a given "#### <contract>" heading. */
function pharosRowUnder(pages: DocPage[], heading: string): { domain: Fact; address: Fact } | undefined {
  const page = pages.find((p) => p.url.includes(CCTP_PAGE)) ?? pages.find((p) => p.text.includes(heading));
  if (!page) return undefined;
  const lines = page.text.split("\n");
  const start = lines.findIndex((l) => l.trim() === `#### ${heading}`);
  if (start < 0) return undefined;
  for (const raw of lines.slice(start + 1, start + 8)) {
    const m = /^\|\s*\*\*Pharos\*\*\s*\|\s*(\d+)\s*\|.*?(0x[0-9a-fA-F]{40})/.exec(raw.trim());
    if (m) {
      const quote = { url: page.url, title: page.title, text: raw.trim() };
      return { domain: { value: m[1]!, quote }, address: { value: m[2]!, quote } };
    }
  }
  return undefined;
}

export function cctpFacts(pages: DocPage[]): CctpFacts {
  const transmitterRow = pharosRowUnder(pages, "MessageTransmitterV2");
  const messengerRow = pharosRowUnder(pages, "TokenMessengerV2");
  const page = pages.find((p) => p.url.includes(CCTP_PAGE));
  const nonceLine = page?.text.split("\n").find((l) => /assigns CCTP nonces offchain/.test(l));
  return {
    transmitter: transmitterRow?.address,
    localDomain: transmitterRow?.domain,
    messenger: messengerRow?.address,
    finalizedAt: pluck(pages, /`finalityThresholdExecuted`\s*≥\s*(\d+)/, CCTP_PAGE),
    version: pluck(pages, /^\|\s*`version`\s*\|.*use (\d+) for CCTP/, CCTP_PAGE),
    nonceNote: nonceLine && page ? { url: page.url, title: page.title, text: nonceLine.trim() } : undefined,
    header: headerTable(pages),
  };
}

/** The "Message Header" table: field, byte offset, solidity type, length, description. Read straight off the page. */
export function headerTable(pages: DocPage[]): HeaderField[] {
  const page = pages.find((p) => p.url.includes(CCTP_PAGE)) ?? pages.find((p) => p.text.includes("### Message Header"));
  if (!page) return [];
  const lines = page.text.split("\n");
  const start = lines.findIndex((l) => l.trim() === "### Message Header");
  if (start < 0) return [];
  const fields: HeaderField[] = [];
  for (const raw of lines.slice(start + 1)) {
    const line = raw.trim();
    if (line.startsWith("#")) break;
    const m = /^\|\s*`(\w+)`\s*\|\s*(\d+)\s*\|\s*`(\w+)`\s*\|\s*(\d+|dynamic)\s*\|\s*(.*?)\s*\|$/.exec(line);
    if (!m) continue;
    fields.push({
      name: m[1]!,
      offset: Number(m[2]),
      type: m[3]!,
      length: m[4] === "dynamic" ? undefined : Number(m[4]),
      description: m[5]!,
      quote: { url: page.url, title: page.title, text: line },
    });
  }
  return fields;
}
