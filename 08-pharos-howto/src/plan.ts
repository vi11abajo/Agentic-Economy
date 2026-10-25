// A plan is what the docs say to do, as steps the runner can carry out. It starts from a Docs MCP answer
// (`howto ask`) and keeps every docs page that was read for it. Each step has to cite one of those pages,
// so nothing gets done that the docs didn't say. A question the docs don't cover gets no steps at all.
import { getAddress, isAddress, parseAbiItem, type AbiEvent, type AbiFunction, type Address } from "viem";
import type { Source } from "./answer.js";

export type Read =
  | { balance: { address: string } }
  | { call: { to: string; sig: string; args?: unknown[] } }
  | { gas_price: Record<string, never> }
  | { receipt: { hash: string } }
  | { code: { address: string } }
  | { logs: { address: string; event: string; args?: Record<string, string>; fromBlock: number | string; toBlock: number | string } };

export interface TxSpec {
  to: string;
  sig?: string; // e.g. "transfer(address to,uint256 amount)"; none for a plain PROS transfer
  args?: unknown[];
  value_pros?: string; // PROS to send with it, e.g. "0.01"
  gas_buffer_pct?: number; // on top of estimate_gas (default from config)
  gas_limit?: number; // or set the limit outright
}

export type Expect =
  | { status: "success" | "reverted" }
  | { event: { address: string; event: string; args?: Record<string, string> } }
  | { erc20_delta: { token: string; holder: string; amount: string } }
  | { native_delta: { holder: string; amount: string } }
  | { fee_charged_on: "gas_limit" | "gas_used" }
  | { equals: string }
  | { at_least: string };

export interface Step {
  title: string;
  source: string; // a docs page this step comes from
  read?: Read;
  tx?: TxSpec;
  expect?: Expect[];
}

export interface StepResult {
  step: number;
  kind: "read" | "tx";
  at: string;
  output?: string;
  prepared?: Record<string, string>;
  hash?: string;
  block?: string;
  checks: { what: string; ok: boolean; got: string }[];
  error?: string;
}

export interface Plan {
  id: string;
  question: string;
  created: string;
  covered: boolean; // false: the docs don't cover it, so the plan can't have steps
  answer: string;
  sources: Source[];
  goal?: string;
  steps: Step[];
  runs: { at: string; sent: boolean; results: StepResult[]; outcome: "success" | "failure" | "prepared" }[];
}

/** One spelling per docs page: no .md, no anchor, no trailing slash, no doubled slashes. */
export function normUrl(u: string): string {
  try {
    const url = new URL(u, "https://docs.pharos.xyz");
    const path = url.pathname.replace(/\/{2,}/g, "/").replace(/\.md$/, "").replace(/\/$/, "");
    return `${url.host.toLowerCase()}${path}`;
  } catch {
    return u.trim().toLowerCase();
  }
}

export const hasSource = (p: Plan, url: string) => p.sources.some((s) => normUrl(s.url) === normUrl(url));

const READ_KINDS = ["balance", "call", "gas_price", "receipt", "code", "logs"];
const EXPECT_KINDS = ["status", "event", "erc20_delta", "native_delta", "fee_charged_on", "equals", "at_least"];

/** Checks steps written by the agent before they are attached to a plan. Returns the problems, if any. */
export function validateSteps(p: Plan, steps: Step[]): string[] {
  const bad: string[] = [];
  if (!p.covered) return ["the docs don't cover this question, so there is nothing documented to carry out"];
  if (!Array.isArray(steps) || steps.length === 0) return ["no steps"];
  steps.forEach((s, i) => {
    const n = `step ${i + 1}`;
    if (!s.title) bad.push(`${n}: no title`);
    if (!s.source) bad.push(`${n}: no source. Every step has to cite the docs page it comes from`);
    else if (!hasSource(p, s.source)) bad.push(`${n}: ${s.source} was not read for this plan (ask, search or page it first with --plan ${p.id})`);
    if (!!s.read === !!s.tx) bad.push(`${n}: needs exactly one of "read" or "tx"`);
    if (s.read) {
      const kinds = Object.keys(s.read);
      if (kinds.length !== 1 || !READ_KINDS.includes(kinds[0])) bad.push(`${n}: read must be one of ${READ_KINDS.join(", ")}`);
      const r = s.read as Record<string, Record<string, unknown>>;
      if (r.call) bad.push(...sigProblems(n, String(r.call.sig), "function"));
      if (r.logs) bad.push(...sigProblems(n, String(r.logs.event), "event"));
    }
    if (s.tx) {
      if (s.tx.to !== "self" && !isAddress(String(s.tx.to), { strict: false })) bad.push(`${n}: tx.to is not an address`);
      if (s.tx.sig) bad.push(...sigProblems(n, s.tx.sig, "function"));
      if (s.tx.value_pros !== undefined && !(Number(s.tx.value_pros) >= 0)) bad.push(`${n}: value_pros must be a number of PROS`);
    }
    for (const e of s.expect ?? []) {
      const k = Object.keys(e);
      if (k.length !== 1 || !EXPECT_KINDS.includes(k[0])) bad.push(`${n}: expect entries are one of ${EXPECT_KINDS.join(", ")}`);
      const ev = (e as { event?: { event: string } }).event;
      if (ev) bad.push(...sigProblems(n, ev.event, "event"));
      if (s.read && ["erc20_delta", "native_delta", "fee_charged_on"].includes(k[0])) bad.push(`${n}: ${k[0]} only makes sense for a tx step`);
    }
  });
  return bad;
}

function sigProblems(n: string, sig: string, kind: "function" | "event"): string[] {
  try {
    kind === "function" ? fn(sig) : ev(sig);
    return [];
  } catch {
    return [`${n}: can't read the ${kind} signature "${sig}"`];
  }
}

export const fn = (sig: string) => parseAbiItem(`function ${sig.replace(/^function\s+/, "")}`) as AbiFunction;
export const ev = (sig: string) => parseAbiItem(`event ${sig.replace(/^event\s+/, "")}`) as AbiEvent;

/** "self" is the signer's address; numbers for (u)int arguments may be written as strings. */
export function resolveAddr(v: string, self?: Address): Address {
  if (v === "self") {
    if (!self) throw new Error(`"self" needs a key in .env`);
    return self;
  }
  if (!isAddress(v, { strict: false })) throw new Error(`${v} is not an address`);
  return getAddress(v);
}

export function encodeArgs(f: AbiFunction, args: unknown[] = [], self?: Address): unknown[] {
  if (args.length !== f.inputs.length) throw new Error(`${f.name} takes ${f.inputs.length} argument(s), the step gives ${args.length}`);
  return f.inputs.map((inp, i) => {
    const v = args[i];
    if (inp.type === "address") return resolveAddr(String(v), self);
    if (/^u?int\d*$/.test(inp.type)) return BigInt(String(v));
    if (inp.type === "bool") return v === true || v === "true";
    return v;
  });
}
