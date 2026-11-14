// One round of watching. Reads what happened since the last round, turns the matches into alerts and puts the new
// ones in the outbox. Transfers come from eth_getLogs, prices from the feed contract, calls from the explorer's
// list of transactions to that address, each one then read back from the RPC so the numbers in the alert are the
// chain's own.
import { decodeFunctionData, formatEther, formatUnits, type Address, type Hex, type PublicClient } from "viem";
import type { Alert } from "./alert.js";
import { ERC20, FEEDS, FEED_ABI, LOG_RANGE, SOCIALSCAN, addressLink, short, txLink } from "./pharos.js";
import type { CallRule, Config, PriceRule, TransferRule } from "./rules.js";
import { enqueue, type State } from "./state.js";
import type { Net } from "./deliver.js";

export interface Ctx {
  client: PublicClient;
  net: Net;
  cfg: Config;
  state: State;
  say: (line: string) => void;
}

const amount = (n: number, max = 4) => n.toLocaleString("en-US", { maximumFractionDigits: max });
const iso = (sec: bigint | number) => new Date(Number(sec) * 1000).toISOString();

// how far back a round may read in one go when siren was off for a while; the rest is picked up next round
export const MAX_ROUND = 10_000n;
// the explorer API can be a few blocks behind the RPC, so the call watch always looks this far back again
// (seen ids stop repeats)
const CALL_OVERLAP = 300n;

async function feedPrice(client: PublicClient, feed: Address, decimals: number): Promise<{ price: number; updatedAt: bigint }> {
  const [, answer, , updatedAt] = await client.readContract({ address: feed, abi: FEED_ABI, functionName: "latestRoundData" });
  return { price: Number(formatUnits(answer, decimals)), updatedAt };
}

async function transfers(ctx: Ctx, rules: TransferRule[], from: bigint, to: bigint): Promise<Alert[]> {
  const out: Alert[] = [];
  const byToken = new Map<string, TransferRule[]>();
  for (const r of rules) byToken.set(r.token.address.toLowerCase(), [...(byToken.get(r.token.address.toLowerCase()) ?? []), r]);
  let prosUsd: number | undefined;
  for (const [address, list] of byToken) {
    const token = list[0].token;
    for (let a = from; a <= to; a += LOG_RANGE) {
      const b = a + LOG_RANGE - 1n < to ? a + LOG_RANGE - 1n : to;
      const logs = await ctx.client.getLogs({ address: address as Address, event: ERC20[0], fromBlock: a, toBlock: b });
      for (const log of logs) {
        const { from: f, to: t, value } = log.args as { from: Address; to: Address; value: bigint };
        const human = Number(formatUnits(value, token.decimals));
        const rule = list.find((r) => human >= r.min && (!r.from || r.from.toLowerCase() === f.toLowerCase()) && (!r.to || r.to.toLowerCase() === t.toLowerCase()));
        if (!rule) continue;
        const facts: Array<[string, string]> = [["from", f], ["to", t]];
        if (token.symbol === "WPROS") {
          prosUsd ??= (await feedPrice(ctx.client, FEEDS["PROS/USD"], 18)).price;
          facts.push(["worth now", `$${amount(human * prosUsd, 2)} at PROS/USD ${prosUsd.toFixed(4)}`]);
        }
        facts.push(["rule", `${rule.min}+ ${token.symbol}`]);
        out.push({
          id: `transfer:${log.transactionHash}:${log.logIndex}`,
          rule: rule.name,
          kind: "transfer",
          title: /^0x0{40}$/.test(f) ? `${token.symbol} minted` : /^0x0{40}$/.test(t) ? `${token.symbol} burned` : `Large ${token.symbol} transfer`,
          value: `${amount(human)} ${token.symbol}`,
          facts,
          links: [["tx", txLink(log.transactionHash!)], [`from ${short(f)}`, addressLink(f)], [`to ${short(t)}`, addressLink(t)]],
          block: String(log.blockNumber),
          at: (log as { blockTimestamp?: bigint }).blockTimestamp ? iso((log as { blockTimestamp: bigint }).blockTimestamp) : new Date().toISOString(),
        });
      }
    }
  }
  return out;
}

async function prices(ctx: Ctx, rules: PriceRule[]): Promise<Alert[]> {
  const out: Alert[] = [];
  const read = new Map<string, { price: number; updatedAt: bigint }>();
  for (const r of rules) {
    const key = r.feed.toLowerCase();
    if (!read.has(key)) read.set(key, await feedPrice(ctx.client, r.feed, r.decimals));
    const { price, updatedAt } = read.get(key)!;
    const st = ctx.state.price[r.name] ?? { armed: true };
    const past = r.side === "above" ? price > r.line : price < r.line;
    const back = r.side === "above" ? price < r.line * (1 - r.rearm) : price > r.line * (1 + r.rearm);
    if (st.armed && past) {
      out.push({
        id: `price:${r.name}:${updatedAt}`,
        rule: r.name,
        kind: "price",
        title: `${r.feedName} is ${r.side} ${r.line}`,
        value: `$${price.toFixed(4)}`,
        facts: [
          ["line", `${r.side} ${r.line}`],
          ["before", st.last === undefined ? "first reading" : `$${st.last.toFixed(4)}`],
          ["feed updated", iso(updatedAt)],
        ],
        links: [["price feed", addressLink(r.feed)]],
        at: iso(updatedAt),
      });
      st.armed = false;
    } else if (!st.armed && back) {
      st.armed = true;
      ctx.say(`${r.name}: ${r.feedName} back at $${price.toFixed(4)}, the line is armed again`);
    }
    st.last = price;
    ctx.state.price[r.name] = st;
  }
  return out;
}

interface ExplorerTx {
  hash: Hex;
  to_address: string | null;
  method_id: string | null;
  value: string;
  block_number: number;
  block_timestamp: string;
  receipt_status: number;
}

async function explorerTxs(net: Net, address: Address, floor: bigint, top: bigint): Promise<ExplorerTx[]> {
  const out: ExplorerTx[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await net(`${SOCIALSCAN}/address/${address}/transactions?page=${page}&size=50`);
    if (!res.ok) throw new Error(`explorer API answered HTTP ${res.status}`);
    const rows = ((await res.json()) as { data?: ExplorerTx[] }).data ?? [];
    for (const t of rows) if (BigInt(t.block_number) > floor && BigInt(t.block_number) <= top) out.push(t);
    if (rows.length < 50 || BigInt(rows.at(-1)!.block_number) <= floor) break;
  }
  return out;
}

async function calls(ctx: Ctx, rules: CallRule[], from: bigint, to: bigint): Promise<Alert[]> {
  const out: Alert[] = [];
  for (const r of rules) {
    const floor = BigInt(ctx.state.calls[r.name] ?? String(from - 1n));
    let rows: ExplorerTx[];
    try {
      rows = await explorerTxs(ctx.net, r.to, floor, to);
    } catch (e) {
      ctx.say(`${r.name}: skipped this round, ${(e as Error).message}; tries again next round`);
      continue;
    }
    const wanted = rows.filter(
      (row) =>
        row.to_address?.toLowerCase() === r.to.toLowerCase() &&
        row.receipt_status === 1 &&
        (!r.selector || row.method_id?.toLowerCase() === r.selector) &&
        (r.minValue === undefined || Number(row.value) >= r.minValue) &&
        !ctx.state.seen[`call:${row.hash}`],
    );
    // the explorer found them; the RPC says what they really were
    const txs = [];
    for (let i = 0; i < wanted.length; i += 8) txs.push(...(await Promise.all(wanted.slice(i, i + 8).map((w) => ctx.client.getTransaction({ hash: w.hash })))));
    for (const [i, row] of wanted.entries()) {
      const tx = txs[i];
      if (tx.to?.toLowerCase() !== r.to.toLowerCase() || (r.selector && tx.input.slice(0, 10).toLowerCase() !== r.selector)) continue;
      const pros = Number(formatEther(tx.value));
      if (r.minValue !== undefined && pros < r.minValue) continue;
      const facts: Array<[string, string]> = [["caller", tx.from], ["function", r.fn ? r.fn.name : tx.input.slice(0, 10)]];
      if (r.fn) {
        try {
          const { args } = decodeFunctionData({ abi: [r.fn], data: tx.input });
          r.fn.inputs.forEach((inp, i) => facts.push([inp.name || `arg ${i}`, String((args ?? [])[i])]));
        } catch {
          facts.push(["arguments", "didn't decode with the given signature"]);
        }
      }
      out.push({
        id: `call:${row.hash}`,
        rule: r.name,
        kind: "call",
        title: r.label,
        value: pros > 0 ? `${amount(pros)} PROS sent with the call` : `call to ${short(r.to)}`,
        facts,
        links: [["tx", txLink(row.hash)], [`contract ${short(r.to)}`, addressLink(r.to)], [`caller ${short(tx.from)}`, addressLink(tx.from)]],
        block: String(tx.blockNumber),
        at: new Date(row.block_timestamp).toISOString(),
      });
    }
    const next = to - CALL_OVERLAP > floor ? to - CALL_OVERLAP : floor;
    ctx.state.calls[r.name] = String(next);
  }
  return out;
}

export interface Round {
  from: bigint;
  to: bigint;
  found: number;
  queued: number;
}

/**
 * Reads blocks after state.lastBlock up to the head. On the very first run it starts at the head, or `since`
 * blocks back when asked to look at the recent past.
 */
export async function round(ctx: Ctx, since = 0n): Promise<Round> {
  const head = await ctx.client.getBlockNumber();
  // first start with nothing to look back at: begin from here, alerts are for what happens next
  if (!ctx.state.lastBlock && since === 0n) ctx.state.lastBlock = String(head);
  const from = ctx.state.lastBlock ? BigInt(ctx.state.lastBlock) + 1n : head - since + 1n;
  const to = from + MAX_ROUND - 1n < head ? from + MAX_ROUND - 1n : head;
  const rules = ctx.cfg.rules;
  const found: Alert[] = [];
  if (from <= to) {
    found.push(...(await transfers(ctx, rules.filter((r): r is TransferRule => r.kind === "transfer"), from, to)));
    found.push(...(await calls(ctx, rules.filter((r): r is CallRule => r.kind === "call"), from, to)));
  }
  found.push(...(await prices(ctx, rules.filter((r): r is PriceRule => r.kind === "price"))));
  let queued = 0;
  for (const a of found) if (enqueue(ctx.state, a)) queued++;
  if (from <= to) ctx.state.lastBlock = String(to);
  return { from, to, found: found.length, queued };
}
