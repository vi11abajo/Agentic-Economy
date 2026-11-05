// Prices in USD, from contracts on chain only: the Chainlink PROS/USD feed, Prosper V2 pairs, Prosper curve
// quotes. The same code answers "now" and "at block N" (Pharos serves historical eth_call), which is what lets
// receipts say what a token was worth the day the wallet bought it.
import { formatUnits } from "viem";
import { WPROS } from "./chain.js";
import { NATIVE, type Holding } from "./adapters.js";
import type { WalletIndex } from "./explorer.js";
import { plain, type Ledger, type Unknown } from "./facts.js";
import type { ToolLine } from "./mcp.js";
import { batch } from "./reads.js";

export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
export const PROS_USD_FEED = "0x371ed36aee5bffbed1a2aa9b7ded7f4eb30f5466";
export const PROSPER_V2_FACTORY = "0x9343d6f1a7058a9ffd43028666db23cfce3e0d1e";

export interface Price {
  usd: number;
  facts: string[];
  how: string;
}

export interface ValuedLine {
  holding: Holding;
  usd?: number;
  facts: string[];
  unknown?: Unknown;
}

export interface Valuation {
  lines: ValuedLine[];
  total: number;
  /** Fact id of the total, so an answer can cite one number for "how much is it all worth". */
  totalFact?: string;
  excluded: string[];
}

const ZERO = "0x0000000000000000000000000000000000000000";
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;
const num = (x: bigint, d: number) => Number(formatUnits(x, d));
const round = (x: number) => plain(x);

export class Pricer {
  private readonly memo = new Map<string, Promise<Price | Unknown>>();
  private readonly pairsAt = new Map<number, Promise<Map<string, { pair: string; tokenIsZero: boolean }>>>();

  constructor(private readonly line: ToolLine, private readonly ledger: Ledger, private readonly ix: WalletIndex) {}

  /** USD per one whole token at `block`. `amount` (raw units) only matters on a curve, where size moves the price. */
  price(token: string, block: number, amount?: bigint): Promise<Price | Unknown> {
    const t = token.toLowerCase();
    const key = `${t}@${block}@${amount ?? ""}`;
    let p = this.memo.get(key);
    if (!p) {
      p = this.work(t, block, amount);
      this.memo.set(key, p);
    }
    return p;
  }

  private async work(t: string, block: number, amount?: bigint): Promise<Price | Unknown> {
    if (t === USDC) return { usd: 1, facts: [], how: "USDC counted as 1 USD" };
    if (t === NATIVE || t === WPROS) return this.pros(block);
    const at = { line: this.line, block };
    const [symbol, decimals] = (await batch(at, [{ to: t, fn: "symbol" }, { to: t, fn: "decimals" }])) as [string?, number?];
    const sym = symbol ?? short(t);
    const dec = Number(decimals ?? 18);
    const tried: string[] = [];

    // 1. A Prosper V2 pair against WPROS.
    tried.push("Prosper V2 pairs");
    const pair = (await this.pairs(block)).get(t);
    if (pair) {
      const [reserves] = (await batch(at, [{ to: pair.pair, fn: "getReserves" }])) as [(readonly bigint[])?];
      if (reserves && reserves[0] > 0n && reserves[1] > 0n) {
        const [rt, rw] = pair.tokenIsZero ? [reserves[0], reserves[1]] : [reserves[1], reserves[0]];
        const inPros = num(rw, 18) / num(rt, dec);
        const pros = await this.pros(block);
        if ("reason" in pros) return pros;
        const pf = this.ledger.add({ label: `${sym} price in PROS (pool spot)`, value: round(inPros), unit: "PROS", contract: pair.pair, call: "getReserves()", block, source: "chain" });
        const uf = this.ledger.add({ label: `${sym} price in USD`, value: round(inPros * pros.usd), unit: "USD", call: `${pf.id} x ${pros.facts[0]}`, block, source: "derived" });
        return { usd: inPros * pros.usd, facts: [uf.id, pf.id, ...pros.facts], how: `Prosper V2 pair ${short(pair.pair)} spot price x PROS/USD feed` };
      }
    }

    // 2. A Prosper bonding-curve market. We find it among the wallet's own counterparties for this token.
    tried.push("a Prosper curve market among the wallet's counterparties");
    const market = await this.curveMarket(t, block);
    if (market) {
      const size = amount && amount > 0n ? amount : 10n ** BigInt(dec);
      const [quote] = (await batch(at, [{ to: market, fn: "quoteSell", args: [size] }])) as [(readonly bigint[])?];
      if (quote && quote[2] > 0n) {
        const inPros = num(quote[2], 18) / num(size, dec);
        const pros = await this.pros(block);
        if ("reason" in pros) return pros;
        const qf = this.ledger.add({ label: `selling ${round(num(size, dec))} ${sym} on its curve pays`, value: round(num(quote[2], 18)), unit: "WPROS", contract: market, call: "quoteSell(amount).netWrappedNativeOut", block, source: "chain" });
        const uf = this.ledger.add({ label: `${sym} price in USD`, value: round(inPros * pros.usd), unit: "USD", call: `${qf.id} / amount x ${pros.facts[0]}`, block, source: "derived" });
        return { usd: inPros * pros.usd, facts: [uf.id, qf.id, ...pros.facts], how: `quoteSell on Prosper curve market ${short(market)} x PROS/USD feed` };
      }
    }

    // 3. A vault share (ERC-4626): one share converts into some amount of its asset, which we price instead.
    tried.push("ERC-4626 convertToAssets");
    const [asset, perShare] = (await batch(at, [{ to: t, fn: "asset" }, { to: t, fn: "convertToAssets", args: [10n ** BigInt(dec)] }])) as [string?, bigint?];
    if (asset && perShare !== undefined && asset.toLowerCase() !== t) {
      const a = asset.toLowerCase();
      const under = await this.price(a, block);
      if ("usd" in under) {
        const aDec = a === USDC ? 6 : Number(((await batch(at, [{ to: a, fn: "decimals" }]))[0] as number | undefined) ?? 18);
        const assetsPerShare = num(perShare, aDec);
        const cf = this.ledger.add({ label: `one ${sym} share converts into`, value: round(assetsPerShare), unit: short(a), contract: t, call: "convertToAssets(1 share)", block, source: "chain" });
        const uf = this.ledger.add({ label: `${sym} price in USD`, value: round(assetsPerShare * under.usd), unit: "USD", call: `${cf.id} x ${under.facts[0] ?? "1"}`, block, source: "derived" });
        return { usd: assetsPerShare * under.usd, facts: [uf.id, cf.id, ...under.facts], how: `convertToAssets on ${short(t)} x price of its asset` };
      }
    }

    return this.ledger.unknown({ reason: "no-price-route", subject: `${sym} (${t})`, details: `tried ${tried.join(" and ")} at block ${block}; none could price it` });
  }

  private async pros(block: number): Promise<Price | Unknown> {
    const key = `pros@${block}`;
    let p = this.memo.get(key);
    if (!p) {
      p = (async () => {
        const [decimals, round_] = (await batch({ line: this.line, block }, [{ to: PROS_USD_FEED, fn: "decimals" }, { to: PROS_USD_FEED, fn: "latestRoundData" }])) as [number?, (readonly bigint[])?];
        if (decimals === undefined || !round_) {
          return this.ledger.unknown({ reason: "read-failed", subject: "PROS/USD price", details: `latestRoundData() on Chainlink feed ${PROS_USD_FEED} failed at block ${block}` });
        }
        const usd = num(round_[1], Number(decimals));
        const updated = new Date(Number(round_[3]) * 1000).toISOString().replace(".000Z", "Z");
        const f = this.ledger.add({ label: `PROS price in USD (feed updated ${updated})`, value: round(usd), unit: "USD", contract: PROS_USD_FEED, call: "latestRoundData().answer", block, source: "chain" });
        return { usd, facts: [f.id], how: "Chainlink PROS/USD feed" };
      })();
      this.memo.set(key, p);
    }
    return p;
  }

  private pairs(block: number) {
    let p = this.pairsAt.get(block);
    if (!p) {
      p = (async () => {
        const at = { line: this.line, block };
        const map = new Map<string, { pair: string; tokenIsZero: boolean }>();
        const [n] = (await batch(at, [{ to: PROSPER_V2_FACTORY, fn: "allPairsLength" }])) as [bigint?];
        if (!n) return map;
        const pairs = (await batch(at, Array.from({ length: Number(n) }, (_, i) => ({ to: PROSPER_V2_FACTORY, fn: "allPairs" as const, args: [BigInt(i)] })))) as (string | undefined)[];
        const known = pairs.filter((x): x is string => !!x);
        const sides = (await batch(at, known.flatMap((pr) => [{ to: pr, fn: "token0" as const }, { to: pr, fn: "token1" as const }]))) as (string | undefined)[];
        known.forEach((pr, i) => {
          const [a, b] = [sides[2 * i]?.toLowerCase(), sides[2 * i + 1]?.toLowerCase()];
          if (a === WPROS && b) map.set(b, { pair: pr.toLowerCase(), tokenIsZero: false });
          if (b === WPROS && a) map.set(a, { pair: pr.toLowerCase(), tokenIsZero: true });
        });
        return map;
      })();
      this.pairsAt.set(block, p);
    }
    return p;
  }

  private async curveMarket(token: string, block: number): Promise<string | undefined> {
    const w = this.ix.wallet.toLowerCase();
    const candidates = [...new Set(this.ix.transfers
      .filter((x) => x.token_address.toLowerCase() === token)
      .map((x) => (x.to_address.toLowerCase() === w ? x.from_address : x.to_address).toLowerCase())
      .filter((a) => a !== w && a !== ZERO))];
    if (!candidates.length) return undefined;
    const answers = (await batch({ line: this.line, block }, candidates.map((c) => ({ to: c, fn: "pToken" as const })))) as (string | undefined)[];
    return candidates.find((_, i) => answers[i]?.toLowerCase() === token);
  }

  /** Every holding in USD at `block`, plus the total and what had to be left out of it. */
  async value(holdings: Holding[], block: number): Promise<Valuation> {
    const lines: ValuedLine[] = [];
    let total = 0;
    const excluded: string[] = [];
    const totalParts: string[] = [];
    for (const h of holdings) {
      const parts = h.underlying?.length ? h.underlying.map((u) => ({ token: u.token, amount: u.amount, fact: u.fact })) : [{ token: h.asset, amount: h.amount, fact: h.facts[0] }];
      let usd = 0;
      const facts: string[] = [];
      let missing: Unknown | undefined;
      for (const part of parts) {
        const dec = part.token === h.asset ? h.decimals : await this.decimalsOf(part.token, block);
        const p = await this.price(part.token, block, part.amount);
        if ("reason" in p) {
          missing = p;
          break;
        }
        usd += num(part.amount, dec) * p.usd;
        facts.push(part.fact, ...p.facts.slice(0, 1));
      }
      if (missing) {
        lines.push({ holding: h, facts: [], unknown: missing });
        excluded.push(h.symbol);
        continue;
      }
      if (h.kind === "debt") usd = -usd;
      const vf = this.ledger.add({ label: `${h.symbol}${h.kind === "token" ? "" : ` (${h.kind}, ${h.protocol})`} worth in USD`, value: round(usd), unit: "USD", call: facts.join(" x "), block, source: "derived" });
      lines.push({ holding: h, usd, facts: [vf.id, ...facts] });
      total += usd;
      totalParts.push(vf.id);
    }
    const tf = totalParts.length ? this.ledger.add({ label: `total worth in USD${excluded.length ? `, without ${excluded.join(", ")}` : ""}`, value: round(total), unit: "USD", call: `sum of ${totalParts.join(", ")}`, block, source: "derived" }) : undefined;
    return { lines, total, totalFact: tf?.id, excluded };
  }

  private async decimalsOf(token: string, block: number): Promise<number> {
    if (token === NATIVE) return 18;
    if (token === USDC) return 6; // Circle USDC on Pharos, checked on chain
    const [d] = (await batch({ line: this.line, block }, [{ to: token, fn: "decimals" }])) as [number?];
    return Number(d ?? 18);
  }
}
