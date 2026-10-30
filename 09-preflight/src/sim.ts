// The dry run: simulate the transaction on the current chain state, price its gas, work out what it would
// change, and decide GO or NO-GO. Nothing here signs or sends anything.
import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatGwei,
  formatUnits,
  parseAbi,
  toEventSelector,
  type Address,
  type Hex,
} from "viem";
import type { Chain, Frame, TraceLog, TxRequest } from "./chain.js";
import { decodeRevert, explainBalance } from "./errors.js";

export interface Settings {
  gas_buffer_pct: number; // gas limit = estimate + this (the Gas Model page's example is 20%)
  max_fee_multiplier: number; // max fee per gas = gas price x this
  max_pros_per_tx: number; // a transaction sending more PROS than this is NO-GO
}
export const DEFAULTS: Settings = { gas_buffer_pct: 20, max_fee_multiplier: 1.5, max_pros_per_tx: 1 };

export const PROS_USD_FEED = "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466" as Address; // Chainlink on Pharos
const UNLIMITED = 2n ** 255n;
const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "event Deposit(address indexed dst, uint256 wad)",
  "event Withdrawal(address indexed src, uint256 wad)",
]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);
const TRANSFER = toEventSelector(erc20[4]);
const APPROVAL = toEventSelector(erc20[5]);
const DEPOSIT = toEventSelector(erc20[6]); // WPROS (WETH9-style) wrap and unwrap
const WITHDRAWAL = toEventSelector(erc20[7]);

export interface Token {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface Change {
  kind: "PROS" | "token" | "allowance";
  token?: Token;
  holder: Address; // for an allowance: the owner
  spender?: Address;
  before: bigint;
  after: bigint;
}

export interface Report {
  block: bigint;
  tx: TxRequest;
  call: string; // what the transaction does, in words
  ok: boolean;
  revert?: string;
  revertIn?: Address; // the contract whose frame reverted first, from the trace
  reverted?: boolean; // false when it fails before any code runs (e.g. not enough PROS for the value)
  gas?: { estimate: bigint; limit: bigint; gasPrice: bigint; priority: bigint; maxFee: bigint; cost: bigint; worst: bigint; usdPerPros?: number };
  changes: Change[];
  traced: boolean;
  warnings: string[];
  verdict: "GO" | "NO-GO";
  reasons: string[]; // why NO-GO
}

const same = (a?: string, b?: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const topicAddr = (t: Hex) => `0x${t.slice(26)}` as Address;

export async function tokenInfo(chain: Chain, address: Address, cache = new Map<string, Token>()): Promise<Token> {
  const hit = cache.get(address.toLowerCase());
  if (hit) return hit;
  const rd = async (fn: "symbol" | "decimals") => decodeFunctionResult({ abi: erc20, functionName: fn, data: await chain.read(address, encodeFunctionData({ abi: erc20, functionName: fn })) });
  const t: Token = { address, symbol: String(await rd("symbol").catch(() => "?")), decimals: Number(await rd("decimals").catch(() => 18)) };
  cache.set(address.toLowerCase(), t);
  return t;
}

async function balanceOf(chain: Chain, token: Address, holder: Address, block?: bigint): Promise<bigint> {
  const data = await chain.read(token, encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [holder] }), block);
  return decodeFunctionResult({ abi: erc20, functionName: "balanceOf", data }) as bigint;
}

async function allowance(chain: Chain, token: Address, owner: Address, spender: Address, block?: bigint): Promise<bigint> {
  const data = await chain.read(token, encodeFunctionData({ abi: erc20, functionName: "allowance", args: [owner, spender] }), block);
  return decodeFunctionResult({ abi: erc20, functionName: "allowance", data }) as bigint;
}

async function prosUsd(chain: Chain): Promise<number | undefined> {
  try {
    const dec = Number(decodeFunctionResult({ abi: feedAbi, functionName: "decimals", data: await chain.read(PROS_USD_FEED, encodeFunctionData({ abi: feedAbi, functionName: "decimals" })) }));
    const r = decodeFunctionResult({ abi: feedAbi, functionName: "latestRoundData", data: await chain.read(PROS_USD_FEED, encodeFunctionData({ abi: feedAbi, functionName: "latestRoundData" })) }) as readonly bigint[];
    return Number(formatUnits(r[1], dec));
  } catch {
    return undefined;
  }
}

/** Every frame of the trace, depth first. */
function frames(f: Frame): Frame[] {
  return [f, ...(f.calls ?? []).flatMap(frames)];
}

/** The deepest frame that failed: where the revert came from. */
function failedFrame(f: Frame): Frame | undefined {
  if (!f.error) return undefined;
  for (const c of f.calls ?? []) {
    const d = failedFrame(c);
    if (d) return d;
  }
  return f;
}

/** PROS moved by calls with value, token transfers and approvals: what the trace says would happen. */
export function effects(root: Frame) {
  const native = new Map<string, bigint>();
  const tokens = new Map<string, bigint>(); // `${token}|${holder}` -> delta
  const approvals = new Map<string, bigint>(); // `${token}|${owner}|${spender}` -> new allowance
  const selfTransfers = new Set<string>(); // `${token}|${holder}`: a transfer from an address to itself
  const add = (m: Map<string, bigint>, k: string, v: bigint) => m.set(k, (m.get(k) ?? 0n) + v);
  for (const f of frames(root)) {
    if (f.error) continue;
    const v = BigInt(f.value ?? "0x0");
    if (v > 0n && f.to && f.type !== "DELEGATECALL" && f.type !== "STATICCALL") {
      add(native, f.from.toLowerCase(), -v);
      add(native, f.to.toLowerCase(), v);
    }
    for (const l of f.logs ?? []) {
      // ERC20 has 3 topics; an ERC721 Transfer has 4 (the token id is indexed) and is not a balance change.
      if (same(l.topics[0], TRANSFER) && l.topics.length === 3) {
        const amount = decodeAbiParameters([{ type: "uint256" }], l.data)[0];
        add(tokens, `${l.address.toLowerCase()}|${topicAddr(l.topics[1]).toLowerCase()}`, -amount);
        add(tokens, `${l.address.toLowerCase()}|${topicAddr(l.topics[2]).toLowerCase()}`, amount);
        if (same(l.topics[1], l.topics[2])) selfTransfers.add(`${l.address.toLowerCase()}|${topicAddr(l.topics[1]).toLowerCase()}`);
      } else if ((same(l.topics[0], DEPOSIT) || same(l.topics[0], WITHDRAWAL)) && l.topics.length === 2) {
        const amount = decodeAbiParameters([{ type: "uint256" }], l.data)[0];
        add(tokens, `${l.address.toLowerCase()}|${topicAddr(l.topics[1]).toLowerCase()}`, same(l.topics[0], DEPOSIT) ? amount : -amount);
      } else if (same(l.topics[0], APPROVAL) && l.topics.length === 3) {
        approvals.set(`${l.address.toLowerCase()}|${topicAddr(l.topics[1]).toLowerCase()}|${topicAddr(l.topics[2]).toLowerCase()}`, decodeAbiParameters([{ type: "uint256" }], l.data)[0]);
      }
    }
  }
  return { native, tokens, approvals, selfTransfers };
}

/** Token balance changes in a mined transaction's logs, keyed like effects().tokens. */
export function receiptTokenDeltas(logs: TraceLog[]): Map<string, bigint> {
  return effects({ type: "CALL", from: "0x0000000000000000000000000000000000000000", logs }).tokens;
}

export interface SimOptions {
  settings: Settings;
  call: string;
}

export async function simulate(chain: Chain, tx: TxRequest, o: SimOptions): Promise<Report> {
  // Read everything at one block, a step behind the head: on a load-balanced RPC the newest block may not be
  // on every node yet.
  const block = (await chain.blockNumber()) - 1n;
  const r: Report = { block, tx, call: o.call, ok: false, changes: [], traced: false, warnings: [], verdict: "NO-GO", reasons: [] };

  const [sim, est] = [await chain.call(tx, block), await chain.estimateGas(tx)];
  const balance = await chain.balance(tx.from, block);
  if (!sim.ok || !est.ok) {
    const bad = !sim.ok ? sim : (est as { data?: Hex; message: string });
    r.revert = decodeRevert(bad.data, bad.message);
    r.reverted = !!bad.data || /revert/i.test(bad.message);
    const t = tx.data !== "0x" ? await chain.trace(tx, block) : null;
    const f = t ? failedFrame(t) : undefined;
    if (f?.to) r.revertIn = f.to;
    r.reasons.push(`the simulation ${r.reverted ? "reverts" : "fails"}: ${r.revert}`);
  } else {
    r.ok = true;
  }

  if (est.ok && est.gas !== undefined) {
    const { gasPrice, priority } = await chain.gasPrice();
    const limit = (est.gas * BigInt(100 + o.settings.gas_buffer_pct) + 99n) / 100n;
    const maxFee = (gasPrice * BigInt(Math.round(o.settings.max_fee_multiplier * 100))) / 100n + priority;
    // Pharos charges the gas used, at the base fee (checked on mainnet in task 08), so the estimate x price is
    // the expected cost and limit x max fee the most it can cost.
    r.gas = { estimate: est.gas, limit, gasPrice, priority, maxFee, cost: est.gas * (gasPrice + priority), worst: limit * maxFee, usdPerPros: await prosUsd(chain) };
    if (balance < tx.value + r.gas.worst) r.reasons.push(`not enough PROS: has ${formatEther(balance)}, needs up to ${formatEther(tx.value + r.gas.worst)} (value + gas limit x max fee)`);
  }
  if (tx.value > BigInt(Math.round(o.settings.max_pros_per_tx * 1e6)) * 10n ** 12n) r.reasons.push(`sends ${formatEther(tx.value)} PROS, more than max_pros_per_tx (${o.settings.max_pros_per_tx})`);

  if (r.ok) {
    const t = await chain.trace(tx, block);
    r.traced = !!t;
    if (!t) r.warnings.push("no call trace from the RPC, so only the sender's PROS is shown");
    const fx = t ? effects(t) : { native: new Map<string, bigint>(), tokens: new Map<string, bigint>(), approvals: new Map<string, bigint>(), selfTransfers: new Set<string>() };
    const cache = new Map<string, Token>();
    // PROS: the sender always (value and gas), everyone else the trace moves PROS to or from.
    const pros = new Map(fx.native);
    pros.set(tx.from.toLowerCase(), (pros.get(tx.from.toLowerCase()) ?? (t ? 0n : -tx.value)) - (r.gas?.cost ?? 0n));
    for (const [holder, d] of pros) {
      if (d === 0n && holder !== tx.from.toLowerCase()) continue; // PROS only passing through a contract
      const before = holder === tx.from.toLowerCase() ? balance : await chain.balance(holder as Address, block);
      r.changes.push({ kind: "PROS", holder: holder as Address, before, after: before + d });
    }
    for (const [k, d] of fx.tokens) {
      const [token, holder] = k.split("|") as [Address, Address];
      // A zero change is left out, except the sender's own transfer to itself: that row shows it stays the same.
      if (d === 0n && !fx.selfTransfers.has(k)) continue;
      const tk = await tokenInfo(chain, token, cache);
      const before = await balanceOf(chain, token, holder, block);
      r.changes.push({ kind: "token", token: tk, holder, before, after: before + d });
      if (fx.selfTransfers.has(k) && same(holder, tx.from)) r.warnings.push(`sending ${tk.symbol} to yourself: the balance stays the same, only the gas is spent`);
    }
    for (const [k, v] of fx.approvals) {
      const [token, owner, spender] = k.split("|") as [Address, Address, Address];
      const tk = await tokenInfo(chain, token, cache);
      r.changes.push({ kind: "allowance", token: tk, holder: owner, spender, before: await allowance(chain, token, owner, spender, block), after: v });
      if (v >= UNLIMITED) r.warnings.push(`unlimited approval: ${spender} could move all of ${same(owner, tx.from) ? "your" : `${owner}'s`} ${tk.symbol}, now and later`);
    }
    if (tx.data !== "0x" && (await chain.code(tx.to)) === "0x") r.warnings.push(`${tx.to} has no code: the call data does nothing there`);
    if (same(tx.from, tx.to) && tx.data === "0x") r.warnings.push("sending PROS to yourself: only the gas is spent");
  }

  if (r.revert && r.revertIn) {
    // Name the token in an insufficient-balance revert when the failing contract is one.
    const tk = await tokenInfo(chain, r.revertIn).catch(() => null);
    if (tk && tk.symbol !== "?") r.revert = explainBalance(r.revert, tk.symbol, tk.decimals);
    r.reasons[0] = `the simulation ${r.reverted ? "reverts" : "fails"}: ${r.revert}`;
  }
  r.verdict = r.reasons.length ? "NO-GO" : "GO";
  return r;
}

// ---------- the report as text ----------

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function amount(c: Change, v: bigint): string {
  if (c.kind === "PROS") return `${formatEther(v)} PROS`;
  if (c.kind === "allowance" && v >= UNLIMITED) return "unlimited";
  return `${formatUnits(v, c.token!.decimals)} ${c.token!.symbol}`;
}

function signed(c: Change): string {
  const d = c.after - c.before;
  if (c.kind === "allowance") return "";
  const s = c.kind === "PROS" ? formatEther(d < 0n ? -d : d) : formatUnits(d < 0n ? -d : d, c.token!.decimals);
  return `  (${d < 0n ? "-" : "+"}${s})`;
}

export function render(r: Report, names: Record<string, string> = {}): string {
  const who = (a: string) => names[a.toLowerCase()] ?? short(a);
  const out = [
    `preflight · simulated at block ${r.block.toLocaleString("en-US")} · nothing sent`,
    `  from   ${r.tx.from}`,
    `  to     ${r.tx.to}`,
    `  does   ${r.call}`,
    "",
    r.ok ? "SIMULATION  success" : `SIMULATION  ${r.reverted ? "REVERT" : "FAILS"}: ${r.revert}${r.revertIn ? ` (in ${r.revertIn})` : ""}`,
  ];
  if (r.gas) {
    const g = r.gas;
    const usd = (wei: bigint) => (g.usdPerPros ? ` (~$${(Number(formatEther(wei)) * g.usdPerPros).toFixed(4)})` : "");
    out.push(
      `GAS         estimate ${g.estimate.toLocaleString("en-US")} at ${formatGwei(g.gasPrice)} gwei = ${formatEther(g.cost)} PROS${usd(g.cost)}`,
      `            limit ${g.limit.toLocaleString("en-US")}, max fee ${formatGwei(g.maxFee)} gwei: at most ${formatEther(g.worst)} PROS${usd(g.worst)}`,
    );
  } else out.push("GAS         no estimate: the node won't estimate a call that fails");
  if (r.changes.length) {
    out.push("CHANGES     before -> after");
    for (const c of r.changes) {
      const label = c.kind === "allowance" ? `allowance ${c.token!.symbol} ${who(c.holder)} -> ${who(c.spender!)}` : `${c.kind === "PROS" ? "PROS" : c.token!.symbol} ${who(c.holder)}`;
      out.push(`  ${label.padEnd(38)} ${amount(c, c.before)} -> ${amount(c, c.after)}${signed(c)}`);
    }
  } else if (!r.ok) out.push("CHANGES     none: it would fail, and a failed transaction changes nothing (a mined revert still costs gas)");
  for (const w of r.warnings) out.push(`WARNING     ${w}`);
  out.push("", r.verdict === "GO" ? "VERDICT  GO: safe to send as simulated" : `VERDICT  NO-GO: ${r.reasons.join("; ")}`);
  return out.join("\n");
}
