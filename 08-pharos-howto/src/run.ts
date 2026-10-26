// Carries out a plan: reads go straight to the Chain MCP; a transaction is prepared (estimate, gas limit, fees,
// nonce) and only signed and broadcast when the run is confirmed. After a transaction is mined, every
// expectation in its step is checked on chain at the exact block, against the block before it.
import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  formatEther,
  formatGwei,
  formatUnits,
  keccak256,
  parseEther,
  parseUnits,
  toEventSelector,
  type Account,
  type Address,
  type Hex,
} from "viem";
import type { Chain, Log, Receipt } from "./chain.js";
import { encodeArgs, ev, fn, resolveAddr, type Expect, type Plan, type Read, type Step, type StepResult, type TxSpec } from "./plan.js";

export interface Settings {
  gas_buffer_pct: number; // Gas Model: estimate + 20% as the example buffer
  max_fee_multiplier: number; // max fee per gas = current gas price x this (only the base fee is charged)
  max_pros_per_tx: number; // refuse to send more PROS than this in one transaction
  receipt_timeout_sec: number;
}
export const DEFAULTS: Settings = { gas_buffer_pct: 20, max_fee_multiplier: 1.5, max_pros_per_tx: 1, receipt_timeout_sec: 90 };

export const PHAROS_CHAIN_ID = 1672;
export const EXPLORER = "https://www.pharosscan.xyz";

type Check = StepResult["checks"][number];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const n = (x: bigint) => x.toLocaleString("en-US");
const same = (a: unknown, b: unknown) => String(a).toLowerCase() === String(b).toLowerCase();

export interface RunOptions {
  send: boolean;
  account?: Account;
  settings: Settings;
  onStep?: (r: StepResult, s: Step) => void;
  pollMs?: number;
}

export async function runPlan(plan: Plan, chain: Chain, o: RunOptions): Promise<Plan["runs"][number]> {
  const results: StepResult[] = [];
  let failed = false;
  let pending = false;
  for (const [i, step] of plan.steps.entries()) {
    const base = { step: i + 1, at: now(), checks: [] as Check[] };
    let r: StepResult;
    try {
      if (step.read) r = { ...base, kind: "read", ...(await doRead(chain, step.read, step.expect ?? [], o.account?.address)) };
      else r = { ...base, kind: "tx", ...(await doTx(chain, step.tx!, step.expect ?? [], o)) };
    } catch (e) {
      r = { ...base, kind: step.read ? "read" : "tx", error: (e as Error).message.split("\n")[0] };
    }
    if (r.kind === "tx" && !r.hash && !r.error) pending = true;
    if (r.error || r.checks.some((c) => !c.ok)) failed = true;
    results.push(r);
    o.onStep?.(r, step);
    // A later step may depend on this one; stop at the first failure, or at the first tx left unsent.
    if (r.error || (r.kind === "tx" && !r.hash)) break;
  }
  return { at: now(), sent: o.send, results, outcome: failed ? "failure" : pending ? "prepared" : "success" };
}

// ---------- reads ----------

async function doRead(chain: Chain, read: Read, expect: Expect[], self?: Address): Promise<Partial<StepResult>> {
  const r = read as Record<string, Record<string, unknown>>;
  let output: string;
  let value: string;
  let receipt: Receipt | null = null;
  if (r.balance) {
    const wei = await chain.balance(resolveAddr(String(r.balance.address), self));
    value = formatEther(wei);
    output = `${value} PROS`;
  } else if (r.gas_price) {
    const g = await chain.gasPrice();
    value = formatGwei(g.gasPrice);
    output = `gas price ${value} gwei, priority fee ${formatGwei(g.priority)} gwei`;
  } else if (r.call) {
    const f = fn(String(r.call.sig));
    const data = encodeFunctionData({ abi: [f], functionName: f.name, args: encodeArgs(f, r.call.args as unknown[], self) });
    const raw = await chain.call(resolveAddr(String(r.call.to), self), data);
    if (f.outputs.length === 0) value = raw;
    else {
      const out = decodeFunctionResult({ abi: [f], functionName: f.name, data: raw }) as unknown;
      value = Array.isArray(out) ? out.map(String).join(", ") : String(out);
    }
    output = `${f.name}(${(r.call.args as unknown[] | undefined ?? []).join(", ")}) = ${value}`;
  } else if (r.code) {
    const code = await chain.code(resolveAddr(String(r.code.address), self));
    const bytes = Math.max(0, (code.length - 2) / 2);
    value = String(bytes);
    output = bytes ? `contract, ${n(BigInt(bytes))} bytes of code` : "no code (not a contract)";
  } else if (r.receipt) {
    receipt = await chain.receipt(String(r.receipt.hash) as Hex);
    if (!receipt) throw new Error(`no receipt for ${r.receipt.hash} (not mined, or not on Pharos mainnet)`);
    value = receipt.status;
    output = `${receipt.status} in block ${n(receipt.block)}, gas used ${n(receipt.gasUsed)}, ${receipt.logs.length} log(s)`;
  } else {
    const l = r.logs as { address: string; event: string; args?: Record<string, string>; fromBlock: number | string; toBlock: number | string };
    const latest = await chain.blockNumber();
    const blk = (b: number | string) => (typeof b === "number" ? BigInt(b) : b === "latest" ? latest : /^latest-\d+$/.test(b) ? latest - BigInt(b.slice(7)) : BigInt(b));
    const e = ev(l.event);
    const logs = await chain.logs({ address: resolveAddr(l.address, self), topics: [toEventSelector(e)], fromBlock: blk(l.fromBlock), toBlock: blk(l.toBlock) });
    const hits = logs.map((x) => decodeLog(x, l.event)).filter((d): d is Decoded => !!d && argsMatch(d.args, l.args, self));
    value = String(hits.length);
    output = `${hits.length} ${e.name} event(s) in blocks ${n(blk(l.fromBlock))}..${n(blk(l.toBlock))}${hits.slice(0, 5).map((h) => `\n    ${fmtArgs(h.args)} (tx ${h.tx})`).join("")}`;
  }
  const checks: Check[] = [];
  for (const x of expect) {
    const e = x as Record<string, unknown>;
    if (e.equals !== undefined) checks.push(cmp(`equals ${e.equals}`, value, String(e.equals), (a, b) => numEq(a, b) ?? same(a, b)));
    else if (e.at_least !== undefined) checks.push(cmp(`at least ${e.at_least}`, value, String(e.at_least), (a, b) => Number(a) >= Number(b)));
    else if (receipt) checks.push(...(await receiptChecks(chain, x, receipt, 0n, self)));
    else checks.push({ what: Object.keys(e)[0], ok: false, got: "needs a receipt read or a tx step" });
  }
  return { output, checks };
}

const numEq = (a: string, b: string) => (/^-?[\d.]+$/.test(a) && /^-?[\d.]+$/.test(b) ? Number(a) === Number(b) : undefined);
const cmp = (what: string, got: string, want: string, f: (a: string, b: string) => boolean): Check => ({ what, ok: f(got, want), got });

// ---------- transactions ----------

async function doTx(chain: Chain, tx: TxSpec, expect: Expect[], o: RunOptions): Promise<Partial<StepResult>> {
  if (!o.account) throw new Error("no key in .env: the user puts PRIVATE_KEY=0x... there, then this can be prepared and signed");
  const from = o.account.address;
  const to = resolveAddr(tx.to, from);
  let data: Hex = "0x";
  let call = "plain PROS transfer";
  if (tx.sig) {
    const f = fn(tx.sig);
    const args = encodeArgs(f, tx.args, from);
    data = encodeFunctionData({ abi: [f], functionName: f.name, args });
    call = `${f.name}(${args.map(String).join(", ")})`;
  }
  const value = parseEther(tx.value_pros ?? "0");
  if (value > parseEther(String(o.settings.max_pros_per_tx))) throw new Error(`sends ${formatEther(value)} PROS, more than max_pros_per_tx (${o.settings.max_pros_per_tx})`);

  const estimate = await chain.estimateGas({ from, to, data, value });
  const gas = tx.gas_limit !== undefined ? BigInt(tx.gas_limit) : (estimate * BigInt(100 + (tx.gas_buffer_pct ?? o.settings.gas_buffer_pct)) + 99n) / 100n;
  const { gasPrice, priority } = await chain.gasPrice();
  const maxFeePerGas = (gasPrice * BigInt(Math.round(o.settings.max_fee_multiplier * 100))) / 100n + priority;
  const nonce = await chain.nonce(from);
  const prepared: Record<string, string> = {
    from,
    to,
    call,
    value: `${formatEther(value)} PROS`,
    gas: `estimate ${n(estimate)}, limit ${n(gas)}${tx.gas_limit !== undefined ? " (set by the plan)" : ` (+${tx.gas_buffer_pct ?? o.settings.gas_buffer_pct}%)`}`,
    fees: `gas price ${formatGwei(gasPrice)} gwei, max fee ${formatGwei(maxFeePerGas)} gwei, priority ${formatGwei(priority)} gwei`,
    worst_case_cost: `${formatEther(value + gas * maxFeePerGas)} PROS (value + limit x max fee)`,
    nonce: String(nonce),
  };
  if (!o.send) return { prepared };

  const raw = await o.account.signTransaction!({ chainId: PHAROS_CHAIN_ID, type: "eip1559", to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas: priority, nonce });
  const local = keccak256(raw);
  // The hash is known before broadcasting. If the broadcast call errors, the transaction may still have gone
  // out, so look for it on chain before calling it a failure, and never send it again.
  let hash: Hex = local;
  let broadcastError: string | undefined;
  try {
    hash = await chain.sendRaw(raw);
  } catch (e) {
    broadcastError = (e as Error).message.split("\n")[0];
  }
  const receipt = await waitReceipt(chain, hash, (broadcastError ? 20 : o.settings.receipt_timeout_sec) * 1000, o.pollMs ?? 2000);
  if (!receipt && broadcastError) return { prepared, error: `broadcast failed and the transaction isn't on chain: ${broadcastError}` };
  if (!receipt) return { prepared, hash, error: `not mined within ${o.settings.receipt_timeout_sec}s, check it later with: howto verify` };
  const checks: Check[] = [];
  for (const e of expect) checks.push(...(await receiptChecks(chain, e, receipt, value, from, gas)));
  return { prepared, hash, block: receipt.block.toString(), output: `${receipt.status} in block ${n(receipt.block)}, gas used ${n(receipt.gasUsed)} of ${n(gas)}`, checks };
}

export async function waitReceipt(chain: Chain, hash: Hex, timeoutMs: number, pollMs: number): Promise<Receipt | null> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const r = await chain.receipt(hash);
    if (r) return r;
    if (Date.now() >= until) return null;
    await sleep(pollMs);
  }
}

/** Checks that need a mined transaction: compared at its block against the block before it. */
export async function receiptChecks(chain: Chain, x: Expect, rc: Receipt, value: bigint, self?: Address, gasLimit?: bigint): Promise<Check[]> {
  const e = x as Record<string, Record<string, string> | string>;
  const before = rc.block - 1n;
  if (e.status) return [{ what: `status ${e.status}`, ok: rc.status === e.status, got: rc.status }];
  if (e.event) {
    const want = e.event as unknown as { address: string; event: string; args?: Record<string, string> };
    const addr = resolveAddr(want.address, self);
    const hits = rc.logs.filter((l) => same(l.address, addr)).map((l) => decodeLog(l, want.event)).filter((d): d is Decoded => !!d);
    const ok = hits.some((h) => argsMatch(h.args, want.args, self));
    return [{ what: `event ${ev(want.event).name}${want.args ? ` ${fmtArgs(want.args)}` : ""} from ${addr}`, ok, got: hits.length ? hits.map((h) => fmtArgs(h.args)).join("; ") : "no such event in the receipt" }];
  }
  if (e.erc20_delta) {
    const d = e.erc20_delta as Record<string, string>;
    const token = resolveAddr(d.token, self);
    const holder = resolveAddr(d.holder, self);
    const dec = Number(await readUint(chain, token, "decimals() view returns (uint8)", []));
    const bal = (b: bigint) => readUint(chain, token, "balanceOf(address) view returns (uint256)", [holder], b);
    const delta = (await bal(rc.block)) - (await bal(before));
    const want = parseUnits(d.amount, dec);
    return [{ what: `token ${token} balance of ${holder} changes by ${d.amount}`, ok: delta === want, got: formatUnits(delta, dec) }];
  }
  if (e.native_delta) {
    const d = e.native_delta as Record<string, string>;
    const holder = resolveAddr(d.holder, self);
    const delta = (await chain.balance(holder, rc.block)) - (await chain.balance(holder, before));
    return [{ what: `PROS balance of ${holder} changes by ${d.amount}`, ok: delta === parseEther(d.amount), got: formatEther(delta) }];
  }
  if (e.fee_charged_on) {
    // What the sender really paid = its PROS drop over the block minus the value it sent.
    const limit = gasLimit ?? (await chain.transaction(rc.hash))?.gas ?? 0n;
    const lost = rc.to && same(rc.to, rc.from) ? 0n : value; // sending to yourself doesn't lose the value
    const paid = (await chain.balance(rc.from, before)) - (await chain.balance(rc.from, rc.block)) - lost;
    const onUsed = rc.gasUsed * rc.effectiveGasPrice;
    const onLimit = limit * rc.effectiveGasPrice;
    const basis = paid === onUsed ? "gas_used" : paid === onLimit ? "gas_limit" : "neither";
    return [{
      what: `fee charged on ${e.fee_charged_on === "gas_limit" ? "the gas limit" : "the gas used"}`,
      ok: basis === e.fee_charged_on,
      got: `paid ${formatEther(paid)} PROS: gas used ${n(rc.gasUsed)} x ${formatGwei(rc.effectiveGasPrice)} gwei = ${formatEther(onUsed)}; limit ${n(limit)} x ${formatGwei(rc.effectiveGasPrice)} gwei = ${formatEther(onLimit)}; so it was charged on ${basis === "gas_used" ? "the gas used" : basis === "gas_limit" ? "the gas limit" : "neither (another tx from this address in the same block?)"}`,
    }];
  }
  return [{ what: Object.keys(e)[0], ok: false, got: "not a check for a transaction" }];
}

async function readUint(chain: Chain, to: Address, sig: string, args: unknown[], block?: bigint): Promise<bigint> {
  const f = fn(sig);
  const raw = await chain.call(to, encodeFunctionData({ abi: [f], functionName: f.name, args }), block);
  return BigInt(decodeFunctionResult({ abi: [f], functionName: f.name, data: raw }) as unknown as bigint | number);
}

// ---------- events ----------

interface Decoded {
  args: Record<string, unknown>;
  tx?: string;
}

function decodeLog(l: Log, sig: string): Decoded | null {
  try {
    const e = ev(sig);
    if (!l.topics?.length || !same(l.topics[0], toEventSelector(e))) return null;
    const d = decodeEventLog({ abi: [e], data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    return { args: d.args as unknown as Record<string, unknown>, tx: l.transactionHash };
  } catch {
    return null;
  }
}

function argsMatch(got: Record<string, unknown>, want: Record<string, string> | undefined, self?: Address): boolean {
  if (!want) return true;
  return Object.entries(want).every(([k, v]) => same(got[k], v === "self" ? self : v));
}

const fmtArgs = (a: Record<string, unknown>) => Object.entries(a).map(([k, v]) => `${k}=${String(v)}`).join(" ");
