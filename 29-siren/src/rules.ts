// The rules file. Three kinds of thing to watch: a token transfer above a size, a price feed crossing a line, and a
// call to a contract. Everything is checked when the file loads, so a typo stops siren at start instead of
// silently watching nothing.
import { getAddress, isAddress, parseAbiItem, toFunctionSelector, type AbiFunction, type Address, type Hex, type PublicClient } from "viem";
import { ERC20, FEEDS, FEED_ABI, TOKENS, type Token } from "./pharos.js";

export interface TransferRule {
  kind: "transfer";
  name: string;
  token: Token;
  min: number;
  from?: Address;
  to?: Address;
}

export interface PriceRule {
  kind: "price";
  name: string;
  feed: Address;
  feedName: string;
  decimals: number;
  side: "above" | "below";
  line: number;
  // after an alert the rule only fires again once the price went back past the line by this share, so a price
  // sitting right on the line doesn't send one message per wiggle
  rearm: number;
}

export interface CallRule {
  kind: "call";
  name: string;
  label: string;
  to: Address;
  selector?: Hex;
  fn?: AbiFunction;
  minValue?: number; // PROS sent with the call
}

export type Rule = TransferRule | PriceRule | CallRule;

export interface Config {
  rules: Rule[];
  pollSeconds: number;
}

export class RuleError extends Error {}

type Raw = Record<string, unknown>;

const num = (r: Raw, k: string, where: string): number => {
  const v = r[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new RuleError(`${where}: "${k}" must be a number >= 0, got ${JSON.stringify(v)}`);
  return v;
};

const addr = (v: unknown, where: string): Address => {
  if (typeof v !== "string" || !isAddress(v, { strict: false })) throw new RuleError(`${where}: ${JSON.stringify(v)} is not an address`);
  return getAddress(v.toLowerCase());
};

async function tokenOf(client: PublicClient, v: unknown, where: string): Promise<Token> {
  if (typeof v === "string" && TOKENS[v.toUpperCase()]) return TOKENS[v.toUpperCase()];
  const address = addr(v, `${where} token (USDC, WPROS or an ERC-20 address)`);
  const known = Object.values(TOKENS).find((t) => t.address.toLowerCase() === address.toLowerCase());
  if (known) return known;
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: ERC20, functionName: "symbol" }),
      client.readContract({ address, abi: ERC20, functionName: "decimals" }),
    ]);
    return { symbol, address, decimals };
  } catch {
    throw new RuleError(`${where}: ${address} doesn't answer symbol()/decimals() on Pharos mainnet, so it isn't an ERC-20 there`);
  }
}

async function feedOf(client: PublicClient, v: unknown, where: string): Promise<{ feed: Address; feedName: string; decimals: number }> {
  const name = typeof v === "string" && FEEDS[v.toUpperCase()] ? v.toUpperCase() : undefined;
  const feed = name ? FEEDS[name] : addr(v, `${where} feed (PROS/USD or a feed address)`);
  try {
    const decimals = await client.readContract({ address: feed, abi: FEED_ABI, functionName: "decimals" });
    return { feed, feedName: name ?? feed, decimals };
  } catch {
    throw new RuleError(`${where}: ${feed} doesn't answer decimals() like a price feed`);
  }
}

/** Reads and checks the rules file. Needs the chain to look up tokens and feeds. */
export async function loadRules(text: string, client: PublicClient): Promise<Config> {
  let json: Raw;
  try {
    json = JSON.parse(text) as Raw;
  } catch (e) {
    throw new RuleError(`the rules file isn't valid JSON: ${(e as Error).message}`);
  }
  const list = json.rules;
  if (!Array.isArray(list) || list.length === 0) throw new RuleError(`the rules file needs a non-empty "rules" list`);
  const names = new Set<string>();
  const rules: Rule[] = [];
  for (const [i, r] of (list as Raw[]).entries()) {
    const name = typeof r.name === "string" && r.name.trim() ? r.name.trim() : `rule ${i + 1}`;
    if (names.has(name)) throw new RuleError(`two rules are called "${name}"`);
    names.add(name);
    const where = `rule "${name}"`;
    if (r.kind === "transfer") {
      rules.push({
        kind: "transfer",
        name,
        token: await tokenOf(client, r.token, where),
        min: num(r, "min", where),
        from: r.from === undefined ? undefined : addr(r.from, `${where} from`),
        to: r.to === undefined ? undefined : addr(r.to, `${where} to`),
      });
    } else if (r.kind === "price") {
      const has = (k: string) => r[k] !== undefined;
      if (has("above") === has("below")) throw new RuleError(`${where}: give exactly one of "above" or "below"`);
      const side = has("above") ? "above" : "below";
      rules.push({ kind: "price", name, ...(await feedOf(client, r.feed ?? "PROS/USD", where)), side, line: num(r, side, where), rearm: r.rearm === undefined ? 0.005 : num(r, "rearm", where) });
    } else if (r.kind === "call") {
      let fn: AbiFunction | undefined;
      let selector: Hex | undefined;
      if (typeof r.function === "string") {
        try {
          fn = parseAbiItem(`function ${r.function.replace(/^function\s+/, "")}`) as AbiFunction;
        } catch {
          throw new RuleError(`${where}: can't read "function": ${r.function} (write it like withdraw(uint256 amount))`);
        }
        selector = toFunctionSelector(fn);
      } else if (r.selector !== undefined) {
        if (typeof r.selector !== "string" || !/^0x[0-9a-fA-F]{8}$/.test(r.selector)) throw new RuleError(`${where}: "selector" must be 4 bytes like 0xa9059cbb`);
        selector = r.selector.toLowerCase() as Hex;
      }
      rules.push({
        kind: "call",
        name,
        label: typeof r.label === "string" ? r.label : name,
        to: addr(r.to, `${where} to`),
        selector,
        fn,
        minValue: r.minValue === undefined ? undefined : num(r, "minValue", where),
      });
    } else {
      throw new RuleError(`${where}: "kind" must be transfer, price or call, got ${JSON.stringify(r.kind)}`);
    }
  }
  const poll = json.pollSeconds === undefined ? 10 : num(json, "pollSeconds", "the rules file");
  return { rules, pollSeconds: Math.max(3, poll) };
}

export function describe(r: Rule): string {
  if (r.kind === "transfer") return `${r.token.symbol} transfer of ${r.min} or more${r.from ? ` from ${r.from}` : ""}${r.to ? ` to ${r.to}` : ""}`;
  if (r.kind === "price") return `${r.feedName} goes ${r.side} ${r.line}`;
  return `call to ${r.to}${r.fn ? ` ${r.fn.name}()` : r.selector ? ` selector ${r.selector}` : ""}${r.minValue ? ` with ${r.minValue}+ PROS` : ""}`;
}
