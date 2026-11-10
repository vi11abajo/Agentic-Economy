// Turns the explorer's index plus the receipts into one line per transaction: what moved, which way, and what kind
// of activity it was. The categories follow how an accountant would sort a bank statement, not how the EVM sees it.
import type { Receipt } from "./chain.js";
import type { ExplorerTx, Hex, History } from "./explorer.js";

export const NATIVE = "native";

export type Category = "transfer_in" | "transfer_out" | "swap" | "approval" | "contract" | "failed";

export const CATEGORY_TITLE: Record<Category, string> = {
  transfer_in: "Transfers in",
  transfer_out: "Transfers out",
  swap: "Swaps",
  approval: "Approvals",
  contract: "Contract interactions",
  failed: "Failed transactions",
};
export const CATEGORY_ONE: Record<Category, string> = {
  transfer_in: "transfer in",
  transfer_out: "transfer out",
  swap: "swap",
  approval: "approval",
  contract: "contract interaction",
  failed: "failed transaction",
};
export const CATEGORY_ORDER: Category[] = ["transfer_in", "transfer_out", "swap", "approval", "contract", "failed"];

export interface Flow {
  /** NATIVE for PROS itself, otherwise the token address (lower-case). */
  asset: string;
  dir: "in" | "out";
  amount: bigint;
  counterparty: Hex;
}

export interface Approval {
  token: Hex;
  spender: Hex;
  amount: bigint;
}

export interface Entry {
  hash: Hex;
  block: number;
  time: number;
  category: Category;
  /** The wallet itself signed and sent this one (so it paid the gas). */
  mine: boolean;
  ok: boolean;
  fee: bigint;
  flows: Flow[];
  approvals: Approval[];
  /** The address the transaction was sent to. */
  target: Hex | null;
  method: string;
  sender: Hex;
}

// topic0 of the events we read straight from receipts
export const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  // Uniswap V2 and V3 style pools (Faroswap runs V3 pools)
  swapV2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  swapV3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  // WETH-style wrapper: Deposit(address indexed dst, uint wad) / Withdrawal(address indexed src, uint wad)
  wrap: "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c",
  unwrap: "0x7fcf532c15f0a6db0bd6d0e038bea71d30d808c7d98cb3bf7268a95bf5081b65",
} as const;

// Method ids whose whole point is to set an allowance.
const APPROVE_METHODS = new Set(["0x095ea7b3", "0x39509351", "0xa457c2d7", "0xd505accf"]);

const topicAddress = (t: Hex) => ("0x" + t.slice(26)).toLowerCase() as Hex;

/** "0.00044942" -> wei. The explorer prints exact decimals; a stray exponent form is handled too. */
export function parseDecimal(text: string, decimals: number): bigint {
  let s = text.trim();
  let shift = 0;
  const e = s.toLowerCase().indexOf("e");
  if (e >= 0) {
    shift = Number(s.slice(e + 1));
    s = s.slice(0, e);
  }
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  let [whole, frac = ""] = s.split(".");
  let digits = whole + frac;
  let point = whole.length + shift + decimals;
  if (point < 0) return 0n;
  digits = digits.padEnd(point, "0");
  const v = BigInt(digits.slice(0, point) || "0");
  return neg ? -v : v;
}

/** Which period transactions the receipts are needed for: anything the explorer ties to the wallet in (from, to]. */
export function periodHashes(h: History, fromBlock: number, toBlock: number): Hex[] {
  const inside = (b: number) => b > fromBlock && b <= toBlock;
  const set = new Set<Hex>();
  for (const t of h.txs) if (inside(t.block)) set.add(t.hash);
  for (const t of h.transfers) if (inside(t.block)) set.add(t.hash);
  for (const t of h.internals) if (inside(t.block)) set.add(t.hash);
  return [...set];
}

export function buildEntries(wallet: Hex, h: History, receipts: Map<Hex, Receipt>, hashes: Hex[]): Entry[] {
  const me = wallet.toLowerCase() as Hex;
  const txByHash = new Map<Hex, ExplorerTx>(h.txs.map((t) => [t.hash, t]));
  const internalsByHash = new Map<Hex, History["internals"]>();
  for (const i of h.internals) internalsByHash.set(i.hash, [...(internalsByHash.get(i.hash) ?? []), i]);
  const firstSeen = new Map<Hex, { block: number; time: number }>();
  for (const r of [...h.txs, ...h.transfers, ...h.internals]) if (!firstSeen.has(r.hash)) firstSeen.set(r.hash, r);

  const entries: Entry[] = [];
  for (const hash of hashes) {
    const receipt = receipts.get(hash);
    if (!receipt) throw new Error(`the node has no receipt for ${hash}, which the explorer lists for this wallet`);
    const tx = txByHash.get(hash);
    const mine = receipt.from === me;
    const flows: Flow[] = [];

    // native PROS: the tx value itself, then whatever moved inside the call (internal transactions)
    if (tx && receipt.ok) {
      const v = parseDecimal(tx.value, 18);
      if (v > 0n && tx.from === me) flows.push({ asset: NATIVE, dir: "out", amount: v, counterparty: tx.to ?? me });
      if (v > 0n && tx.to === me) flows.push({ asset: NATIVE, dir: "in", amount: v, counterparty: tx.from });
    }
    for (const i of internalsByHash.get(hash) ?? []) {
      if (!i.ok || !receipt.ok) continue;
      const v = parseDecimal(i.value, 18);
      if (v === 0n) continue;
      if (i.from === me) flows.push({ asset: NATIVE, dir: "out", amount: v, counterparty: i.to });
      if (i.to === me) flows.push({ asset: NATIVE, dir: "in", amount: v, counterparty: i.from });
    }

    // tokens: exact amounts from the Transfer logs (3 topics = ERC20; 4 would be an NFT)
    const approvals: Approval[] = [];
    let swapped = false;
    for (const log of receipt.logs) {
      const t0 = log.topics[0];
      if (t0 === TOPIC.swapV2 || t0 === TOPIC.swapV3) swapped = true;
      if (log.topics.length === 2 && topicAddress(log.topics[1]) === me && (t0 === TOPIC.wrap || t0 === TOPIC.unwrap)) {
        // Wrapped PROS works like WETH: wrapping emits Deposit(dst, wad) and unwrapping Withdrawal(src, wad), no
        // Transfer at all. Plenty of other contracts use the same event shape, so it only counts as a wrap when the
        // same amount of native PROS went into (or came out of) that very contract in this transaction.
        const wad = BigInt(log.data === "0x" ? 0 : log.data);
        const wrap = t0 === TOPIC.wrap;
        const pros = flows.find((f) => f.asset === NATIVE && f.counterparty === log.address && f.amount === wad && f.dir === (wrap ? "out" : "in"));
        if (pros && wad > 0n) flows.push({ asset: log.address, dir: wrap ? "in" : "out", amount: wad, counterparty: log.address });
        continue;
      }
      if (log.topics.length !== 3) continue;
      if (t0 === TOPIC.transfer) {
        const from = topicAddress(log.topics[1]);
        const to = topicAddress(log.topics[2]);
        const amount = BigInt(log.data === "0x" ? 0 : log.data);
        if (amount === 0n || from === to) continue;
        if (from === me) flows.push({ asset: log.address, dir: "out", amount, counterparty: to });
        if (to === me) flows.push({ asset: log.address, dir: "in", amount, counterparty: from });
      } else if (t0 === TOPIC.approval && topicAddress(log.topics[1]) === me) {
        approvals.push({ token: log.address, spender: topicAddress(log.topics[2]), amount: BigInt(log.data === "0x" ? 0 : log.data) });
      }
    }

    const seen = tx ?? firstSeen.get(hash)!;
    const entry: Entry = {
      flows: netted(flows),
      hash,
      block: seen.block,
      time: seen.time,
      category: "contract",
      mine,
      ok: receipt.ok,
      fee: mine ? receipt.fee : 0n,
      approvals: [],
      target: receipt.to,
      method: tx?.method || tx?.methodId || "",
      sender: receipt.from,
    };
    entry.category = categorize(entry, swapped, approvals.length > 0, h.contracts);
    // Approval events also fire inside swaps when a router spends an allowance; only real approve calls count here.
    const approveCall = tx ? APPROVE_METHODS.has(tx.methodId.toLowerCase()) : false;
    if (entry.category === "approval" || (mine && approveCall)) entry.approvals = approvals;
    entries.push(entry);
  }
  return entries.sort((a, b) => a.block - b.block || a.hash.localeCompare(b.hash));
}

/**
 * A router that takes 0.0088 PROS and sends 0.0002 back as change hasn't really been paid twice: within one
 * transaction, money going both ways between the wallet and the same address is folded into one net movement. The
 * tie-out doesn't care (the net is the same), but a person reading "sent 0.0086 PROS for 1 pTACO" does.
 */
export function netted(flows: Flow[]): Flow[] {
  const net = new Map<string, { asset: string; counterparty: Hex; v: bigint }>();
  for (const f of flows) {
    const k = `${f.asset}|${f.counterparty}`;
    const cur = net.get(k) ?? { asset: f.asset, counterparty: f.counterparty, v: 0n };
    cur.v += f.dir === "in" ? f.amount : -f.amount;
    net.set(k, cur);
  }
  return [...net.values()]
    .filter((n) => n.v !== 0n)
    .map((n) => ({ asset: n.asset, counterparty: n.counterparty, dir: n.v > 0n ? ("in" as const) : ("out" as const), amount: n.v > 0n ? n.v : -n.v }));
}

function categorize(e: Entry, swapped: boolean, approved: boolean, contracts: Set<string>): Category {
  if (e.mine && !e.ok) return "failed";
  const outs = e.flows.filter((f) => f.dir === "out");
  const ins = e.flows.filter((f) => f.dir === "in");
  if (swapped && outs.length && ins.length) return "swap";
  if (e.mine && !e.flows.length && approved) return "approval";
  const toPeople = (fs: Flow[]) => fs.every((f) => !contracts.has(f.counterparty));
  if (outs.length && !ins.length) {
    // sent to wallets: a payment, even when it went out through a token call or a batch contract
    if (toPeople(outs) || !e.mine) return "transfer_out";
    return "contract";
  }
  if (ins.length && !outs.length) {
    // someone else's transaction put money here, or the wallet received from a plain address
    if (!e.mine || toPeople(ins)) return "transfer_in";
    return "contract";
  }
  return "contract";
}
