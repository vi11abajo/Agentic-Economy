// One scan: read every source at once (Faroswap V3 pools and Chainlink on Pharos, the three exchanges' books),
// price every route at every size, decide, and log it. The DEX legs are real swaps run inside eth_call; the CEX
// legs are filled against the live books. Nothing is ever sent.
import { formatUnits, parseUnits, type PublicClient } from "viem";
import { buyWithQuote, fetchBook, sellBase, EXCHANGES, type Book, type Exchange } from "./cex.js";
import { oracles, pools, simulateSwap, type Oracles, type Pool } from "./chain.js";
import type { Settings } from "./config.js";
import { MAX_FEED_AGE_SEC, USDC, WPROS } from "./constants.js";
import { costRoute, decide, type Decision, type Leg, type RouteResult, type Venue } from "./routes.js";

export interface Scan {
  at: string;
  block: number;
  oracles: Oracles;
  sources: { id: string; kind: "dex" | "cex"; bidUsd: number; askUsd: number; detail: string; gapPct: number }[];
  skipped: string[]; // sources left out of this scan, with the reason
  routes: RouteResult[];
  decision: Decision;
}

const SLIPPAGE_GUARD = 0.005; // a prepared order's limit: 0.5% worse than the simulated or book price

function dexVenue(c: PublicClient, p: Pool, o: Oracles, s: Settings): Venue {
  const id = `faroswap-${p.fee / 10_000}%`;
  const feeRate = p.fee / 1_000_000;
  const gasUsd = (gas: bigint) => Number(gas + BigInt(s.dex_overhead_gas)) * o.baseFeeGwei * 1e-9 * o.prosUsd;
  const mid = p.mid * o.usdcUsd;
  return {
    id,
    kind: "dex",
    askUsd: mid,
    bidUsd: mid,
    withdrawPros: 0,
    depositPros: 0,
    async buy(usd) {
      const usdcIn = parseUnits((usd / o.usdcUsd).toFixed(6), 6);
      const r = await simulateSwap(c, p, USDC, usdcIn);
      const pros = Number(formatUnits(r.out, 18));
      return {
        pros, usd, feeUsd: usd * feeRate, gasUsd: gasUsd(r.swapGas), complete: r.out > 0n,
        prepared: { venue: id, type: "swap", pool: p.address, tokenIn: "USDC", amountIn: formatUnits(usdcIn, 6), expectedOut: `${pros} WPROS`, minOut: `${pros * (1 - SLIPPAGE_GUARD)} WPROS`, simulatedGas: Number(r.swapGas), simulated: "eth_call on the live pool, not sent" },
      };
    },
    async sell(prosAmt) {
      const wIn = parseUnits(prosAmt.toFixed(18), 18);
      const r = await simulateSwap(c, p, WPROS, wIn);
      const usdc = Number(formatUnits(r.out, 6));
      return {
        pros: prosAmt, usd: usdc * o.usdcUsd, feeUsd: prosAmt * mid * feeRate, gasUsd: gasUsd(r.swapGas), complete: r.out > 0n,
        prepared: { venue: id, type: "swap", pool: p.address, tokenIn: "WPROS", amountIn: prosAmt, expectedOut: `${usdc} USDC`, minOut: `${usdc * (1 - SLIPPAGE_GUARD)} USDC`, simulatedGas: Number(r.swapGas), simulated: "eth_call on the live pool, not sent" },
      };
    },
  };
}

function cexVenue(b: Book, o: Oracles, s: Settings): Venue {
  const f = s.exchanges[b.exchange];
  const taker = f.taker_pct / 100;
  return {
    id: b.exchange,
    kind: "cex",
    askUsd: (b.asks[0]?.[0] ?? NaN) * o.usdtUsd,
    bidUsd: (b.bids[0]?.[0] ?? NaN) * o.usdtUsd,
    withdrawPros: f.withdraw_pros,
    depositPros: f.deposit_pros,
    async buy(usd) {
      const fill = buyWithQuote(b, usd / o.usdtUsd);
      const pros = fill.base * (1 - taker); // the fee is taken from the PROS bought
      return {
        pros, usd: fill.quote * o.usdtUsd, feeUsd: fill.quote * taker * o.usdtUsd, gasUsd: 0, complete: fill.complete,
        prepared: { venue: b.exchange, type: "limit order", symbol: "PROS-USDT", side: "buy", size: Number(fill.base.toFixed(3)), price: Number((fill.worst * (1 + SLIPPAGE_GUARD)).toFixed(4)), note: "payload only: no API keys, not sent" },
      };
    },
    async sell(prosAmt) {
      const fill = sellBase(b, prosAmt);
      const usdt = fill.quote * (1 - taker);
      return {
        pros: prosAmt, usd: usdt * o.usdtUsd, feeUsd: fill.quote * taker * o.usdtUsd, gasUsd: 0, complete: fill.complete,
        prepared: { venue: b.exchange, type: "limit order", symbol: "PROS-USDT", side: "sell", size: Number(prosAmt.toFixed(3)), price: Number((fill.worst * (1 - SLIPPAGE_GUARD)).toFixed(4)), note: "payload only: no API keys, not sent" },
      };
    },
  };
}

export async function scan(c: PublicClient, s: Settings, only?: { exchanges?: Exchange[] }): Promise<Scan> {
  const exchanges = only?.exchanges ?? EXCHANGES;
  const [o, ps, books] = await Promise.all([
    oracles(c),
    pools(c),
    Promise.allSettled(exchanges.map((e) => fetchBook(e))),
  ]);
  const skipped: string[] = [];
  if (o.ageSec > MAX_FEED_AGE_SEC) throw new Error(`Chainlink feeds are ${Math.round(o.ageSec / 60)} min old: USD values can't be trusted`);

  const venues: Venue[] = [];
  const sources: Scan["sources"] = [];
  const gap = (px: number) => ((px - o.prosUsd) / o.prosUsd) * 100;
  for (const p of ps) {
    const v = dexVenue(c, p, o, s);
    if (p.usdcReserve < s.min_pool_usdc) {
      skipped.push(`${v.id}: only ${p.usdcReserve.toFixed(0)} USDC in the pool (min ${s.min_pool_usdc})`);
      continue;
    }
    const g = gap(v.bidUsd);
    sources.push({ id: v.id, kind: "dex", bidUsd: v.bidUsd, askUsd: v.askUsd, gapPct: g, detail: `mid ${p.mid.toFixed(5)} USDC, pool holds ${Math.round(p.wprosReserve).toLocaleString("en-US")} WPROS + ${Math.round(p.usdcReserve).toLocaleString("en-US")} USDC` });
    if (Math.abs(g) > s.max_oracle_gap_pct) skipped.push(`${v.id}: ${g.toFixed(2)}% off Chainlink, treated as bad data`);
    else venues.push(v);
  }
  books.forEach((r, i) => {
    const ex = exchanges[i];
    if (r.status === "rejected") return skipped.push(`${ex}: ${(r.reason as Error).message}`);
    const v = cexVenue(r.value, o, s);
    const g = gap((v.bidUsd + v.askUsd) / 2);
    sources.push({ id: ex, kind: "cex", bidUsd: v.bidUsd, askUsd: v.askUsd, gapPct: g, detail: `bid ${r.value.bids[0]?.[0]} / ask ${r.value.asks[0]?.[0]} USDT, ${r.value.bids.length}+${r.value.asks.length} levels` });
    if (Math.abs(g) > s.max_oracle_gap_pct) skipped.push(`${ex}: ${g.toFixed(2)}% off Chainlink, treated as bad data`);
    else venues.push(v);
  });

  // Every buy venue against every sell venue, except pool against pool (DEX vs CEX and CEX vs CEX).
  const routes: RouteResult[] = [];
  for (const size of s.sizes_usd) {
    const buys = new Map<string, Leg>();
    for (const v of venues) buys.set(v.id, await v.buy(size));
    for (const b of venues) {
      for (const sl of venues) {
        if (b === sl || (b.kind === "dex" && sl.kind === "dex")) continue;
        const buy = buys.get(b.id)!;
        const sell = await sl.sell(buy.pros);
        routes.push(costRoute(b, sl, size, buy, sell, o.prosUsd, s));
      }
    }
  }
  if (venues.length < 2) skipped.push(`only ${venues.length} usable source(s): nothing to compare`);
  return { at: new Date().toISOString(), block: o.block, oracles: o, sources, skipped, routes, decision: decide(routes, s) };
}
