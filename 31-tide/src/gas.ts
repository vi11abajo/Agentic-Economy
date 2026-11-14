// Reading gas. Three views: right now (base fee, what eth_gasPrice suggests, what tips txs are paying), the past
// hours (base fee at evenly spaced blocks, so a day costs ~48 reads instead of 100k), and what recent txs really
// paid (effectiveGasPrice from their receipts).
import { formatGwei, type PublicClient } from "viem";
import type { Network } from "./net.js";

export interface Sample {
  at: string;
  network: Network["name"];
  block: string;
  base: number; // gwei
  gasPrice: number; // gwei, eth_gasPrice
  tips: { p10: number; p50: number; p90: number }; // gwei, from the last 20 blocks that had txs (see sample())
}

const gwei = (x: bigint) => Number(formatGwei(x));

export function percentile(xs: number[], p: number): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export async function sample(c: PublicClient, n: Network, now = new Date()): Promise<Sample> {
  const [block, gasPrice, fh] = await Promise.all([c.getBlock(), c.getGasPrice(), c.getFeeHistory({ blockCount: 20, rewardPercentiles: [10, 50, 90] })]);
  const used = (fh.reward ?? []).filter((_, i) => fh.gasUsedRatio[i] > 0);
  return {
    at: now.toISOString(),
    network: n.name,
    block: String(block.number),
    base: gwei(block.baseFeePerGas ?? 0n),
    gasPrice: gwei(gasPrice),
    // per block the node gives the 10th/50th/90th percentile tip. Legacy txs count their whole price over the base
    // fee as tip, so the middle of the range can be far above what it takes to get in. p10 here is the low end of
    // the per-block lows: what the cheapest txs that did get in paid.
    tips: {
      p10: percentile(used.map((r) => gwei(r[0])), 10),
      p50: percentile(used.map((r) => gwei(r[1])), 50),
      p90: percentile(used.map((r) => gwei(r[2])), 90),
    },
  };
}

export interface Point {
  at: string;
  block: string;
  base: number;
}

/** Base fee at `points` blocks spread evenly over the last `hours`. */
export async function past(c: PublicClient, n: Network, hours: number, points = 48): Promise<Point[]> {
  const head = await c.getBlockNumber();
  const span = BigInt(Math.round((hours * 3600) / n.blockSeconds));
  const step = span / BigInt(points) || 1n;
  const heights: bigint[] = [];
  for (let i = BigInt(points); i >= 0n; i--) if (head - i * step >= 0n) heights.push(head - i * step);
  const out: Point[] = [];
  // a few at a time: the public RPC throttles bursts
  for (let i = 0; i < heights.length; i += 5) {
    const blocks = await Promise.all(heights.slice(i, i + 5).map((h) => c.getBlock({ blockNumber: h })));
    for (const b of blocks) out.push({ at: new Date(Number(b.timestamp) * 1000).toISOString(), block: String(b.number), base: gwei(b.baseFeePerGas ?? 0n) });
  }
  return out;
}

/** effectiveGasPrice of up to `max` recent txs from the last `maxBlocks` blocks, newest first. */
export async function paid(c: PublicClient, max = 30, maxBlocks = 200): Promise<number[]> {
  const head = await c.getBlockNumber();
  const out: number[] = [];
  for (let i = 0n; i < BigInt(maxBlocks) && out.length < max; i += 10n) {
    const blocks = await Promise.all(Array.from({ length: 10 }, (_, k) => head - i - BigInt(k)).filter((h) => h >= 0n).map((h) => c.getBlock({ blockNumber: h })));
    const hashes = blocks.flatMap((b) => b.transactions).slice(0, max - out.length);
    for (let k = 0; k < hashes.length; k += 6) {
      const rs = await Promise.all(hashes.slice(k, k + 6).map((h) => c.getTransactionReceipt({ hash: h })));
      out.push(...rs.map((r) => gwei(r.effectiveGasPrice)));
    }
  }
  return out;
}

const BARS = "▁▂▃▄▅▆▇█";
export function spark(xs: number[]): string {
  if (!xs.length) return "";
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  return xs.map((x) => (hi === lo ? BARS[0] : BARS[Math.round(((x - lo) / (hi - lo)) * (BARS.length - 1))])).join("");
}

export function stats(xs: number[]) {
  return { min: Math.min(...xs), median: percentile(xs, 50), max: Math.max(...xs) };
}

export const g = (x: number) => `${Number(x.toFixed(4))} gwei`;
