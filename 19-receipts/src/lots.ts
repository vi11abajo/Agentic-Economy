// "How did I do on this token?" The wallet's own history, transaction by transaction, read from receipts:
// what it paid, what it got, what it simply received. Average cost, realized and unrealized P&L, and for tokens
// that just arrived, the honest version: you didn't buy these, here is only how the price moved since.
import { formatUnits } from "viem";
import { confirmTransfer, receiptTransfers, ZERO, type TxReceipt } from "./chain.js";
import type { WalletIndex } from "./explorer.js";
import { plain, type Ledger, type Unknown } from "./facts.js";
import { groupFlows } from "./flows.js";
import type { ToolLine } from "./mcp.js";
import type { Pricer } from "./prices.js";
import { batch } from "./reads.js";
import { NATIVE } from "./adapters.js";

export interface LotCtx {
  line: ToolLine;
  ledger: Ledger;
  pricer: Pricer;
  ix: WalletIndex;
  block: number;
  wallet: string;
}

export interface StoryEvent {
  tx: string;
  block: number;
  kind: "bought" | "received" | "sold" | "sent";
  amount: bigint;
  /** What was paid (bought) or got back (sold), in USD at that block. */
  usd?: number;
  fact: string;
}

export interface Arrival {
  tx: string;
  block: number;
  amount: bigint;
  from: string;
  priceThenUsd?: number;
}

export interface TokenStory {
  token: string;
  symbol: string;
  decimals: number;
  balance: bigint;
  events: StoryEvent[];
  received: Arrival[];
  avgCostUsd?: number;
  realizedUsd?: number;
  unrealizedUsd?: number;
  soldReceivedUsd?: number;
  nowPriceUsd?: number;
  facts: { balance?: string; avgCost?: string; realized?: string; unrealized?: string; received?: string; priceNow?: string };
  unknowns: Unknown[];
}

const num = (x: bigint, d: number) => Number(formatUnits(x, d));
const round = (x: number) => plain(x);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

export async function tokenStory(ctx: LotCtx, token: string): Promise<TokenStory> {
  const t = token.toLowerCase();
  const w = ctx.wallet.toLowerCase();
  const [symbolRaw, decimalsRaw, balanceRaw] = (await batch(ctx, [{ to: t, fn: "symbol" }, { to: t, fn: "decimals" }, { to: t, fn: "balanceOf", args: [w] }])) as [string?, number?, bigint?];
  const symbol = symbolRaw ?? short(t);
  const decimals = Number(decimalsRaw ?? 18);
  const story: TokenStory = { token: t, symbol, decimals, balance: balanceRaw ?? 0n, events: [], received: [], facts: {}, unknowns: [] };
  const say = (u: Unknown) => story.unknowns.push(ctx.ledger.unknown(u));
  const show = (x: bigint) => `${round(num(x, decimals))} ${symbol}`;

  if (balanceRaw === undefined) {
    say({ reason: "read-failed", subject: symbol, details: `balanceOf(${short(w)}) on ${t} failed at block ${ctx.block}` });
    return story;
  }
  story.facts.balance = ctx.ledger.add({ label: `${symbol} in the wallet`, value: round(num(story.balance, decimals)), raw: story.balance.toString(), unit: symbol, contract: t, call: `balanceOf(${short(w)})`, block: ctx.block, source: "chain" }).id;

  const flows = flowsUpTo(ctx).filter((f) => [...f.in, ...f.out].some((m) => m.token === t)).sort((a, b) => a.block - b.block);
  if (!flows.some((f) => f.in.some((m) => m.token === t))) {
    if (story.balance > 0n) say({ reason: "no-cost-basis", subject: symbol, details: `the wallet holds ${show(story.balance)} but the explorer history has no incoming transfers of it, so there is nothing to say what it cost` });
    return story;
  }

  // Walk the history oldest first, every amount taken from the receipt, not the explorer.
  let boughtQty = 0n;
  let boughtCost = 0;
  let receivedQty = 0n;
  let realized = 0;
  let soldReceived = 0;
  let chainNet = 0n;
  let anyBought = false;
  let unpriced = 0; // trades we couldn't value: any of them and the profit figures are off

  for (const f of flows) {
    const r = await receiptTransfers(ctx.line, f.hash);
    if (r.status !== 1) continue;
    checkExplorer(ctx, f.hash, t, r, symbol, say);
    const tin = sum(r.transfers.filter((x) => x.token === t && x.to === w && x.from !== w).map((x) => x.amount));
    const tout = sum(r.transfers.filter((x) => x.token === t && x.from === w && x.to !== w).map((x) => x.amount));
    const net = tin - tout;
    chainNet += net;
    if (net === 0n) continue;

    const paid = r.transfers.filter((x) => x.token !== t && x.from === w && x.to !== w).map((x) => ({ token: x.token, amount: x.amount }));
    if (r.from === w && r.nativeValue > 0n) paid.push({ token: NATIVE, amount: r.nativeValue });
    const got = r.transfers.filter((x) => x.token !== t && x.to === w && x.from !== w).map((x) => ({ token: x.token, amount: x.amount }));
    // Native PROS paid back by a router shows up only as an internal call; the explorer lists it, the receipt's
    // WPROS Withdrawal by the router backs it up.
    for (const m of f.in.filter((x) => x.token === "native")) got.push({ token: NATIVE, amount: BigInt(Math.round(Number(m.amount) * 1e18)) });

    if (net > 0n) {
      if (paid.length) {
        const usd = await worth(ctx, paid, r.block);
        if (usd === undefined) {
          say({ reason: "no-price-route", subject: `${symbol} bought in ${f.hash}`, details: `the wallet paid with ${paid.map((p) => short(p.token)).join(", ")} at block ${r.block} and that can't be priced on chain, so this purchase has no cost` });
          receivedQty += net;
          unpriced++;
          continue;
        }
        anyBought = true;
        boughtQty += net;
        boughtCost += usd;
        const fact = ctx.ledger.add({ label: `bought ${show(net)} for`, value: round(usd), unit: "USD", tx: f.hash, block: r.block, call: "receipt Transfer logs + prices at that block", source: "explorer+chain" });
        story.events.push({ tx: f.hash, block: r.block, kind: "bought", amount: net, usd, fact: fact.id });
      } else {
        receivedQty += net;
        const then = await ctx.pricer.price(t, r.block, net);
        const priceThenUsd = "usd" in then ? then.usd : undefined;
        const from = r.transfers.find((x) => x.token === t && x.to === w)?.from ?? "?";
        story.received.push({ tx: f.hash, block: r.block, amount: net, from, priceThenUsd });
        // Someone else can buy a token and have it delivered here; then the pool is the "from" and the buyer is the
        // tx sender. Say who sent the tx, so nobody goes hunting for a payment this wallet never made.
        const sender = r.from?.toLowerCase();
        const how = sender && sender !== w ? `in a tx sent by another wallet, ${short(sender)}; this wallet paid nothing` : "nothing paid in that tx";
        const fact = ctx.ledger.add({ label: `received ${show(net)} from ${short(from)} (${how})`, value: round(num(net, decimals)), unit: symbol, tx: f.hash, block: r.block, call: "receipt Transfer logs", source: "explorer+chain" });
        story.events.push({ tx: f.hash, block: r.block, kind: "received", amount: net, fact: fact.id });
      }
    } else {
      const q = -net;
      const fromBought = q < boughtQty ? q : boughtQty;
      const share = num(fromBought, decimals) / num(q, decimals);
      const costOut = boughtQty > 0n ? boughtCost * (num(fromBought, decimals) / num(boughtQty, decimals)) : 0;
      boughtCost -= costOut;
      boughtQty -= fromBought;
      const rest = q - fromBought;
      receivedQty -= rest < receivedQty ? rest : receivedQty;
      if (got.length) {
        const usd = await worth(ctx, got, r.block);
        if (usd === undefined) {
          say({ reason: "no-price-route", subject: `${symbol} sold in ${f.hash}`, details: `the wallet got back ${got.map((p) => short(p.token)).join(", ")} at block ${r.block}, which can't be priced on chain` });
          unpriced++;
          continue;
        }
        realized += usd * share - costOut;
        soldReceived += usd * (1 - share);
        const fact = ctx.ledger.add({ label: `sold ${show(q)} for`, value: round(usd), unit: "USD", tx: f.hash, block: r.block, call: "receipt Transfer logs + prices at that block", source: "explorer+chain" });
        story.events.push({ tx: f.hash, block: r.block, kind: "sold", amount: q, usd, fact: fact.id });
      } else {
        const fact = ctx.ledger.add({ label: `sent ${show(q)} away with nothing back in that tx`, value: round(num(q, decimals)), unit: symbol, tx: f.hash, block: r.block, call: "receipt Transfer logs", source: "explorer+chain" });
        story.events.push({ tx: f.hash, block: r.block, kind: "sent", amount: q, fact: fact.id });
      }
    }
  }

  // The per-token completeness check: the receipts must add up to what the chain holds today.
  if (chainNet !== story.balance) {
    say({ reason: "history-incomplete", subject: symbol, details: `the history adds up to ${show(chainNet)} but the chain holds ${show(story.balance)} at block ${ctx.block}; some transfers are missing from the explorer, so no profit figure is given` });
    story.events = [];
    story.received = [];
    return story;
  }

  const now = await ctx.pricer.price(t, ctx.block, story.balance > 0n ? story.balance : undefined);
  if ("usd" in now) {
    story.nowPriceUsd = now.usd;
    story.facts.priceNow = now.facts[0];
  } else if (story.balance > 0n) {
    story.unknowns.push(now);
  }

  if (anyBought && unpriced === 0) {
    const totalBoughtQty = story.events.filter((e) => e.kind === "bought").reduce((a, e) => a + e.amount, 0n);
    const totalCost = story.events.filter((e) => e.kind === "bought").reduce((a, e) => a + (e.usd ?? 0), 0);
    story.avgCostUsd = totalCost / num(totalBoughtQty, decimals);
    story.facts.avgCost = ctx.ledger.add({ label: `average price paid per ${symbol}`, value: round(story.avgCostUsd), unit: "USD", call: `sum of buys / ${show(totalBoughtQty)}`, block: ctx.block, source: "derived" }).id;
    if (story.events.some((e) => e.kind === "sold")) {
      story.realizedUsd = realized;
      story.facts.realized = ctx.ledger.add({ label: `realized profit on ${symbol} sales (average cost)`, value: round(realized), unit: "USD", call: "sales - average cost of what was sold", block: ctx.block, source: "derived" }).id;
    }
    if (boughtQty > 0n && story.nowPriceUsd !== undefined) {
      story.unrealizedUsd = num(boughtQty, decimals) * story.nowPriceUsd - boughtCost;
      story.facts.unrealized = ctx.ledger.add({ label: `unrealized profit on the ${show(boughtQty)} still held from buys`, value: round(story.unrealizedUsd), unit: "USD", call: `${show(boughtQty)} x price now - their cost`, block: ctx.block, source: "derived" }).id;
    }
  }
  if (soldReceived) story.soldReceivedUsd = soldReceived;

  if (story.received.length && receivedQty > 0n) {
    const qty = story.received.reduce((a, x) => a + x.amount, 0n);
    const priced = story.received.filter((x) => x.priceThenUsd !== undefined);
    const thenAvg = priced.length ? priced.reduce((a, x) => a + x.priceThenUsd! * num(x.amount, decimals), 0) / priced.reduce((a, x) => a + num(x.amount, decimals), 0) : undefined;
    const parts = [`received ${show(qty)} in ${story.received.length} transfer(s) where this wallet paid nothing (first from ${short(story.received[0].from)} at block ${story.received[0].block})`, `${show(receivedQty)} of them still held`];
    if (thenAvg !== undefined && story.nowPriceUsd !== undefined) {
      const change = story.nowPriceUsd - thenAvg;
      story.facts.received = ctx.ledger.add({ label: `price change per ${symbol} since it arrived (not earnings)`, value: round(change), unit: "USD", call: `price now ${round(story.nowPriceUsd)} - price on arrival ${round(thenAvg)}`, block: ctx.block, source: "derived" }).id;
      parts.push(`price on arrival ${round(thenAvg)} USD, now ${round(story.nowPriceUsd)} USD (${story.facts.received})`);
    }
    say({ reason: "received-not-bought", subject: symbol, details: `${parts.join("; ")}; this wallet never paid for them, so there is no real profit to report, only the price move` });
  }
  return story;
}

function sum(xs: bigint[]): bigint {
  return xs.reduce((a, b) => a + b, 0n);
}

/** USD value of a few legs at a block; undefined if any of them can't be priced. */
async function worth(ctx: LotCtx, legs: { token: string; amount: bigint }[], block: number): Promise<number | undefined> {
  let usd = 0;
  for (const leg of legs) {
    const p = await ctx.pricer.price(leg.token, block, leg.amount);
    if (!("usd" in p)) return undefined;
    const dec = leg.token === NATIVE ? 18 : Number(((await batch({ line: ctx.line, block }, [{ to: leg.token, fn: "decimals" }]))[0] as number | undefined) ?? (leg.token === "0xc879c018db60520f4355c26ed1a6d572cdac1815" ? 6 : 18));
    usd += num(leg.amount, dec) * p.usd;
  }
  return usd;
}

/** Each explorer row for this token in this tx must match the receipt's own log. If not, say so; the chain wins. */
function checkExplorer(ctx: LotCtx, hash: string, token: string, r: TxReceipt, symbol: string, say: (u: Unknown) => void): void {
  for (const row of ctx.ix.transfers.filter((x) => x.transaction_hash === hash && x.token_address.toLowerCase() === token)) {
    const v = confirmTransfer(row, r);
    if (!v.ok) {
      say({ reason: "explorer-chain-mismatch", subject: `${symbol} in ${hash}`, details: `the explorer says ${row.value} ${symbol} (log ${row.log_index}); the receipt says ${v.chainAmount === null ? "there is no such transfer" : formatUnits(v.chainAmount, row.token_info?.decimals ?? 18)}; the receipt's number is used` });
    }
  }
}

export interface VaultEarnings {
  protocol: string;
  asset: string;
  deposited: bigint;
  withdrawn: bigint;
  now: bigint;
  earned: bigint;
  decimals: number;
  /** Fact id of the earned figure; the deposit and withdrawal facts are listed too. */
  fact: string;
  facts: string[];
}

/**
 * What a vault position has made: worth now, plus what the wallet already took out, minus what it put in, all
 * in the vault's own asset (USDC in, USDC out). Deposits and withdrawals are read from receipts.
 */
export async function vaultEarnings(ctx: LotCtx, h: import("./adapters.js").Holding): Promise<VaultEarnings | Unknown> {
  const w = ctx.wallet.toLowerCase();
  const under = h.underlying?.[0];
  if (!under || h.underlying!.length !== 1) {
    return ctx.ledger.unknown({ reason: "no-cost-basis", subject: `${h.symbol} (${h.protocol})`, details: "this position is not a single-asset vault, so deposits and withdrawals can't be added up in one asset" });
  }
  const places = new Set([h.asset.toLowerCase(), (h.venue ?? h.asset).toLowerCase()]);
  const asset = under.token;
  let deposited = 0n;
  let withdrawn = 0n;
  const facts: string[] = [];
  const flows = flowsUpTo(ctx).filter((f) => [...f.in, ...f.out].some((m) => m.token === asset && places.has(m.counterparty))).sort((a, b) => a.block - b.block);
  // the vault's asset by name: "earned 0.07 stPROS" reads better than "earned 0.07 0x6b0a...5ec4"
  const [dRaw, symRaw] = (await batch(ctx, [{ to: asset, fn: "decimals" }, { to: asset, fn: "symbol" }])) as [number?, string?];
  const decimals = asset === "0xc879c018db60520f4355c26ed1a6d572cdac1815" ? 6 : Number(dRaw ?? 18);
  const sym = asset === "0xc879c018db60520f4355c26ed1a6d572cdac1815" ? "USDC" : (symRaw || short(asset));
  for (const f of flows) {
    const r = await receiptTransfers(ctx.line, f.hash);
    if (r.status !== 1) continue;
    const put = sum(r.transfers.filter((x) => x.token === asset && x.from === w && places.has(x.to)).map((x) => x.amount));
    const took = sum(r.transfers.filter((x) => x.token === asset && x.to === w && places.has(x.from)).map((x) => x.amount));
    if (put) facts.push(ctx.ledger.add({ label: `put into ${h.protocol}`, value: round(num(put, decimals)), unit: sym, tx: f.hash, block: r.block, call: "receipt Transfer logs", source: "explorer+chain" }).id);
    if (took) facts.push(ctx.ledger.add({ label: `taken out of ${h.protocol}`, value: round(num(took, decimals)), unit: sym, tx: f.hash, block: r.block, call: "receipt Transfer logs", source: "explorer+chain" }).id);
    deposited += put;
    withdrawn += took;
  }
  const shares = await shareTrail(ctx, h, places);
  if (shares) return shares;
  if (deposited === 0n) {
    return ctx.ledger.unknown({ reason: "no-cost-basis", subject: `${h.symbol} (${h.protocol})`, details: `no deposit of ${sym} from this wallet into ${h.protocol} shows up in its history; the shares may have arrived by transfer, so what they cost is unknown` });
  }
  const earned = under.amount + withdrawn - deposited;
  const fact = ctx.ledger.add({ label: `earned in ${h.protocol} (worth now + taken out - put in)`, value: round(num(earned, decimals)), unit: sym, call: `${under.fact} + withdrawals - deposits`, block: ctx.block, source: "derived" });
  return { protocol: h.protocol, asset, deposited, withdrawn, now: under.amount, earned, decimals, fact: fact.id, facts: [under.fact, ...facts] };
}

/** The wallet's history as of the scan's block: rows the explorer already has from later blocks don't belong here. */
function flowsUpTo(ctx: LotCtx) {
  return groupFlows(ctx.ix).filter((f) => f.block <= ctx.block);
}

/**
 * Earned = worth now + taken out - put in only holds if every share the wallet has came from its own deposits.
 * So follow the share token itself: shares from someone else mean nobody here paid for them, and shares the
 * history can't add up to the balance on chain mean a deposit or a withdrawal is missing from it.
 */
async function shareTrail(ctx: LotCtx, h: import("./adapters.js").Holding, places: Set<string>): Promise<Unknown | undefined> {
  const w = ctx.wallet.toLowerCase();
  const share = h.asset.toLowerCase();
  const subject = `${h.symbol} (${h.protocol})`;
  const amt = (x: bigint) => plain(num(x, h.decimals));
  let net = 0n;
  for (const f of flowsUpTo(ctx).filter((f) => [...f.in, ...f.out].some((m) => m.token === share))) {
    const r = await receiptTransfers(ctx.line, f.hash);
    if (r.status !== 1) continue;
    for (const x of r.transfers.filter((x) => x.token === share)) {
      if (x.to === w && x.from !== w) {
        net += x.amount;
        if (x.from !== ZERO && !places.has(x.from)) {
          return ctx.ledger.unknown({ reason: "received-not-bought", subject, details: `${amt(x.amount)} ${h.symbol} came in from ${short(x.from)} in tx ${f.hash}; this wallet didn't deposit for them, so what the position earned can't be added up` });
        }
      } else if (x.from === w && x.to !== w) {
        net -= x.amount;
      }
    }
  }
  if (net !== h.amount) {
    return ctx.ledger.unknown({ reason: "history-incomplete", subject, details: `the history adds up to ${amt(net)} ${h.symbol}, the chain says the wallet holds ${amt(h.amount)} at block ${ctx.block}; a deposit or withdrawal is missing, so there is no earnings figure` });
  }
  return undefined;
}
