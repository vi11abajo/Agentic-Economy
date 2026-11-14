// Turns a Move into words: what kind of move it was, how big in dollars, and why it might matter. Every number in
// the "why" lines is read from the chain at that tx's block (balances before and after, the PROS/USD feed then)
// or from the explorer's own record of the other side. Nothing is guessed: when sonar doesn't know, it says less.
import { formatEther, formatUnits, type Address, type PublicClient } from "viem";
import type { Leg, Move, Party } from "./history.js";
import { ABI, PROS_USD, USDC, WPROS, ZERO, addressLink, short, txLink, type Get } from "./pharos.js";

export interface Whale {
  address: string;
  label: string;
  minUsd?: number;
}

export type Kind = "swap" | "entered" | "exited" | "into-contract" | "out-of-contract" | "sent" | "received" | "minted" | "burned";

export interface Story {
  whale: Whale;
  move: Move;
  kind: Kind;
  headline: string;
  usd?: number;
  why: string[];
  links: Array<[string, string]>;
}

const isPros = (l: Pick<Leg, "token">) => l.token === null || l.token === WPROS.toLowerCase();
const isUsdc = (l: Pick<Leg, "token">) => l.token === USDC.toLowerCase();

/** USD per unit: USDC is a dollar, PROS and WPROS use the feed, anything else the explorer's price if it has one. */
export function unitUsd(l: Pick<Leg, "token" | "explorerPrice">, pros: number): number | undefined {
  if (isUsdc(l)) return 1;
  if (isPros(l)) return pros;
  return l.explorerPrice;
}

export const fmt = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 2 : 6 });


interface Net {
  symbol: string;
  token: string | null;
  amount: number; // positive
  party: Party; // the biggest leg's other side
  explorerPrice?: number;
}

/** Per token: what came in minus what went out (routers often hand a bit back in the same tx). */
export function netLegs(m: Move): { outs: Net[]; ins: Net[] } {
  const by = new Map<string, { sum: number; legs: Leg[] }>();
  for (const l of m.legs) {
    const k = l.token ?? "native";
    const e = by.get(k) ?? { sum: 0, legs: [] };
    e.sum += l.dir === "in" ? l.amount : -l.amount;
    e.legs.push(l);
    by.set(k, e);
  }
  const outs: Net[] = [];
  const ins: Net[] = [];
  for (const { sum, legs } of by.values()) {
    if (Math.abs(sum) < 1e-12) continue;
    const dir = sum > 0 ? "in" : "out";
    const main = legs.filter((l) => l.dir === dir).sort((a, b) => b.amount - a.amount)[0] ?? legs[0];
    (dir === "in" ? ins : outs).push({ symbol: main.symbol, token: main.token, amount: Math.abs(sum), party: main.party, explorerPrice: main.explorerPrice });
  }
  return { outs, ins };
}

export function moveUsd(m: Move, pros: number): number | undefined {
  const { outs, ins } = netLegs(m);
  const side = (xs: Net[]) => xs.reduce<number | undefined>((s, x) => (unitUsd(x, pros) === undefined ? s : (s ?? 0) + x.amount * unitUsd(x, pros)!), undefined);
  const a = side(outs);
  const b = side(ins);
  return a === undefined ? b : b === undefined ? a : Math.max(a, b);
}

const list = (xs: Net[]) => xs.slice(0, 3).map((x) => `${fmt(x.amount)} ${x.symbol}`).join(" + ");
const who = (p: Party) => (p.address === ZERO ? "the zero address" : p.name ? `${p.name} (${short(p.address)})` : p.contract ? `contract ${short(p.address)}` : `wallet ${short(p.address)}`);

export function classify(m: Move): { kind: Kind; headline: string } {
  const { outs, ins } = netLegs(m);
  const via = m.called && m.called.address !== outs[0]?.party.address ? ` via ${who(m.called)}` : "";
  if (outs.length && ins.length) {
    const minted = ins.find((x) => x.party.address === ZERO);
    if (minted) return { kind: "entered", headline: `put ${list(outs)} into ${who(m.called ?? outs[0].party)} and got ${fmt(minted.amount)} ${minted.symbol} minted` };
    const burned = outs.find((x) => x.party.address === ZERO);
    if (burned) return { kind: "exited", headline: `gave back ${fmt(burned.amount)} ${burned.symbol} to ${who(m.called ?? ins[0].party)} and took out ${list(ins)}` };
    return { kind: "swap", headline: `swapped ${list(outs)} for ${list(ins)}${m.called ? ` via ${who(m.called)}` : ""}` };
  }
  if (outs.length) {
    const p = outs[0].party;
    if (p.address === ZERO) return { kind: "burned", headline: `burned ${list(outs)}` };
    if (p.contract) return { kind: "into-contract", headline: `put ${list(outs)} into ${who(p)}${via}` };
    return { kind: "sent", headline: `sent ${list(outs)} to ${who(p)}${via}` };
  }
  const p = ins[0].party;
  if (p.address === ZERO) return { kind: "minted", headline: `got ${list(ins)} minted` };
  if (p.contract) return { kind: "out-of-contract", headline: `took ${list(ins)} out of ${who(p)}` };
  return { kind: "received", headline: `received ${list(ins)} from ${who(p)}` };
}

async function balanceAt(client: PublicClient, holder: string, token: string | null, block: bigint): Promise<number> {
  if (token === null) return Number(formatEther(await client.getBalance({ address: holder as Address, blockNumber: block })));
  const raw = await client.readContract({ address: token as Address, abi: ABI, functionName: "balanceOf", args: [holder as Address], blockNumber: block });
  // the explorer already gave decimal-adjusted amounts; these three are the ones sonar compares on chain
  return Number(formatUnits(raw, token === USDC.toLowerCase() ? 6 : 18));
}

const pct = (x: number) => (x < 0.005 ? "under 1%" : `${Math.round(x * 100)}%`);
const days = (from: string, to: string) => Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000));

export interface Context {
  client: PublicClient;
  get: Get;
  pros: number; // PROS/USD now
  watched: Map<string, Whale>;
}

export async function explain(ctx: Context, whale: Whale, m: Move): Promise<Story> {
  const { kind, headline } = classify(m);
  const { outs, ins } = netLegs(m);
  const why: string[] = [];
  const block = BigInt(m.block);

  // 1. how much of what it held: only for PROS, WPROS and USDC, where sonar knows the decimals for sure
  const priced = [...outs, ...ins].filter((x) => x.token === null || isUsdc(x) || isPros(x)).sort((a, b) => b.amount * (unitUsd(b, ctx.pros) ?? 0) - a.amount * (unitUsd(a, ctx.pros) ?? 0));
  const main = priced[0];
  if (main) {
    try {
      const [before, after] = await Promise.all([balanceAt(ctx.client, whale.address, main.token, block - 1n), balanceAt(ctx.client, whale.address, main.token, block)]);
      const sym = main.token === null ? "PROS" : main.symbol;
      if (outs.includes(main)) why.push(before > 0 ? `that was ${pct(Math.min(main.amount, before) / before)} of its ${sym}: ${fmt(before)} before this tx, ${fmt(after)} after` : `its ${sym} balance went from ${fmt(before)} to ${fmt(after)}`);
      else why.push(before > 0 ? `its ${sym} went from ${fmt(before)} to ${fmt(after)} (+${Math.round(((after - before) / before) * 100)}%)` : `it held no ${sym} before this tx, now ${fmt(after)}`);
    } catch {
      // an RPC without that block's state: leave the line out rather than guess
    }
  }

  // 2. a PROS <-> USDC swap: the price it got against the feed at that same block
  const p = [...outs, ...ins].find(isPros);
  const u = [...outs, ...ins].find(isUsdc);
  if (kind === "swap" && p && u && p.amount > 0) {
    try {
      const [, answer] = await ctx.client.readContract({ address: PROS_USD, abi: ABI, functionName: "latestRoundData", blockNumber: block });
      const feed = Number(formatUnits(answer, 18));
      const got = u.amount / p.amount;
      const diff = ((got - feed) / feed) * 100;
      why.push(`${outs.includes(p) ? "sold" : "bought"} PROS at $${got.toFixed(4)}; the PROS/USD feed said $${feed.toFixed(4)} at that block (${diff >= 0 ? "+" : ""}${diff.toFixed(1)}%)`);
    } catch {
      /* same as above */
    }
  }

  // 3. the other side
  const other = (outs[0] ?? ins[0]).party;
  const twin = ctx.watched.get(other.address);
  if (twin && twin.address !== whale.address) why.push(`the other side is another watched whale: ${twin.label}`);
  else if (other.address !== ZERO && !other.contract && (kind === "sent" || kind === "received")) {
    try {
      const prof = (await ctx.get(`address/${other.address}/profile`)) as { first_transaction?: { block_timestamp?: string }; funding_transaction?: { from_address?: string } };
      const first = prof.first_transaction?.block_timestamp;
      const funder = prof.funding_transaction?.from_address?.toLowerCase();
      const parts: string[] = [];
      if (first) parts.push(`first active ${first.slice(0, 10)}${days(first, m.time) <= 7 ? `, only ${days(first, m.time)} days before this` : ""}`);
      if (funder) parts.push(`first funded by ${ctx.watched.get(funder)?.label ?? short(funder)}${funder === whale.address ? " (this whale itself)" : ""}`);
      if (parts.length) why.push(`${short(other.address)} is a wallet: ${parts.join(", ")}`);
    } catch {
      /* the explorer had nothing: say nothing */
    }
  } else if (other.contract && other.name) why.push(`${other.name} is the explorer's name for ${short(other.address)}`);

  return {
    whale,
    move: m,
    kind,
    headline,
    usd: moveUsd(m, ctx.pros),
    why,
    links: [["tx", txLink(m.hash)], [`other side ${short(other.address)}`, addressLink(other.address)]],
  };
}


