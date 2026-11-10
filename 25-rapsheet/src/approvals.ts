// Approvals that name an address as the spender. No index lists them that way and the node gives at most 1,000
// blocks of logs per call, so this scans a recent window in 1,000-block steps, four at a time, and says how far
// back it looked.
import type { ApprovalLog, Chain } from "./chain.js";
import type { Hex } from "./explorer.js";
import { ago, plural } from "./finding.js";

export interface Scan {
  logs: ApprovalLog[];
  /** "the last 100000 blocks (about 26 hours)" */
  span: string;
}

export async function approvalsNaming(chain: Chain, spender: Hex, head: number, window: number): Promise<Scan> {
  const from = Math.max(0, head - window + 1);
  const spans: [number, number][] = [];
  for (let b = from; b <= head; b += 1000) spans.push([b, Math.min(b + 999, head)]);
  const logs: ApprovalLog[] = [];
  for (let i = 0; i < spans.length; i += 4) {
    const batch = await Promise.all(spans.slice(i, i + 4).map(([a, b]) => chain.approvalsTo(spender, a, b)));
    for (const x of batch) logs.push(...x);
  }
  const [t1, t0] = await Promise.all([chain.blockTime(head), chain.blockTime(from)]);
  return { logs: logs.sort((x, y) => y.block - x.block), span: `the last ${plural(head - from + 1, "block")} (about ${ago(t1 - t0)})` };
}
