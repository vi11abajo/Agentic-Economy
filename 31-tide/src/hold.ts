// Holding one transaction. The rule is small on purpose: go when the base fee is at or under the line, and go
// anyway a little before the deadline. The line is yours (--max-gwei) or, by default, the lowest base fee in the
// recent history. The tip is the low end of what txs actually paid lately, so tide never bids up a price nobody
// competes for.
import { parseGwei, type Address, type Hex } from "viem";
import type { Sample } from "./gas.js";

export interface Job {
  id: string;
  network: "mainnet" | "atlantic";
  from: Address;
  tx: { to: Address; value: string; data?: Hex };
  created: string;
  deadline: string;
  line: number; // gwei: go when the base fee is at or under this
  lineFrom: "you" | "history";
  atRequest: Sample;
  paidLately: number[]; // gwei, effectiveGasPrice of recent txs at request time
  status: "holding" | "sent" | "mined" | "reverted" | "would-send";
  checks: number;
  went?: { at: string; why: string; forced: boolean; sample: Sample; maxFee: string; tip: string; gas: string };
  hash?: Hex;
  receipt?: { block: string; gasUsed: string; effective: number; status: "success" | "reverted" };
}

// leave this long before the deadline so the tx is mined before it, not just sent
export const MARGIN_SECONDS = 30;

export function decide(s: Sample, job: Pick<Job, "line" | "deadline">, now: Date): { go: boolean; forced: boolean; why: string } {
  const left = (Date.parse(job.deadline) - now.getTime()) / 1000;
  if (s.base <= job.line) return { go: true, forced: false, why: `base fee ${s.base} gwei is at or under the line (${job.line} gwei)` };
  if (left <= MARGIN_SECONDS) return { go: true, forced: true, why: `deadline in ${Math.max(0, Math.round(left))} s and base fee still ${s.base} gwei (line ${job.line}): sending anyway` };
  return { go: false, forced: false, why: `base fee ${s.base} gwei is over the line (${job.line} gwei), ${fmtLeft(left)} to the deadline` };
}

export function fmtLeft(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`;
}

/**
 * EIP-1559 fees. You pay base + tip; maxFee only caps it. The tip is the low end of what got in lately (blocks on
 * Pharos are nearly empty, nobody is outbidding anyone). A forced send at the deadline gets more room on the cap,
 * so a base fee that jumps in the next blocks can't leave it behind.
 */
export function fees(s: Sample, forced: boolean): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const tip = parseGwei(s.tips.p10.toFixed(9));
  return { maxPriorityFeePerGas: tip, maxFeePerGas: parseGwei(s.base.toFixed(9)) * (forced ? 3n : 2n) + tip };
}

export interface Compare {
  paid: number; // gwei per gas
  gasUsed: bigint;
  rows: Array<{ what: string; gwei: number; pros: number; vsPaid: number }>; // vsPaid: PROS more (+) or less (-) than paid
}

const pros = (gweiPerGas: number, gas: bigint) => (gweiPerGas * Number(gas)) / 1e9;

/** The receipt next to what the same tx would have cost at request time, a few ways. */
export function compare(job: Job, effective: number, gasUsed: bigint): Compare {
  const r = job.atRequest;
  const now = { what: "if sent right at request time (base + tip then)", gwei: r.base + r.tips.p10 };
  const asked = { what: "at eth_gasPrice at request time (what most wallets offer)", gwei: r.gasPrice };
  const lately = job.paidLately.length ? [{ what: `the median recent tx paid (${job.paidLately.length} txs)`, gwei: [...job.paidLately].sort((a, b) => a - b)[Math.floor(job.paidLately.length / 2)] }] : [];
  const paidPros = pros(effective, gasUsed);
  return {
    paid: effective,
    gasUsed,
    rows: [now, asked, ...lately].map((x) => ({ ...x, pros: pros(x.gwei, gasUsed), vsPaid: pros(x.gwei, gasUsed) - paidPros })),
  };
}
