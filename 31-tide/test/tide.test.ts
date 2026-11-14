import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseGwei, type Address, type Hex } from "viem";
import { percentile, spark, type Sample } from "../src/gas.js";
import { MARGIN_SECONDS, compare, decide, fees, type Job } from "../src/hold.js";
import { NETWORKS } from "../src/net.js";
import { hold, newJob, receiptText, type Deps } from "../src/run.js";
import { Store } from "../src/store.js";

const TO = "0xa991B44106b336B547259bD2B9b2f45931414348" as Address;
const FROM = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb" as Address;
const s = (base: number, extra: Partial<Sample> = {}): Sample => ({ at: "", network: "mainnet", block: "1", base, gasPrice: 10, tips: { p10: 0, p50: 0, p90: 0 }, ...extra });

test("decide: under the line goes, over it holds, near the deadline goes anyway", () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const job = { line: 10, deadline: "2026-11-14T12:10:00Z" };
  assert.equal(decide(s(10), job, now).go, true);
  assert.deepEqual(decide(s(12), job, now), { go: false, forced: false, why: "base fee 12 gwei is over the line (10 gwei), 10 min 0 s to the deadline" });
  const late = new Date(Date.parse(job.deadline) - (MARGIN_SECONDS - 1) * 1000);
  const d = decide(s(12), job, late);
  assert.equal(d.go && d.forced, true);
});

test("fees: the low-end tip, and more room on the cap when forced", () => {
  const x = s(10, { tips: { p10: 0.5, p50: 9, p90: 90 } });
  assert.deepEqual(fees(x, false), { maxPriorityFeePerGas: parseGwei("0.5"), maxFeePerGas: parseGwei("20.5") });
  assert.deepEqual(fees(x, true), { maxPriorityFeePerGas: parseGwei("0.5"), maxFeePerGas: parseGwei("30.5") });
});

test("compare: paid against request time, eth_gasPrice and what others paid", () => {
  const job = { atRequest: s(1, { gasPrice: 10 }), paidLately: [1, 1, 10] } as unknown as Job;
  const c = compare(job, 1, 21000n);
  assert.deepEqual(
    c.rows.map((r) => [r.gwei, Number(r.vsPaid.toFixed(8))]),
    [
      [1, 0],
      [10, 0.000189],
      [1, 0],
    ],
  );
});

test("percentile and sparkline", () => {
  assert.equal(percentile([5, 1, 3], 50), 3);
  assert.equal(percentile([], 50), 0);
  assert.equal(spark([1, 1, 1]), "▁▁▁");
  assert.equal(spark([0, 10]), "▁█");
});

// A pretend chain whose base fee follows a script, a clock that only moves when tide sleeps, and a wallet that
// records what it was asked to send.
function world(bases: number[], opts: { wallet?: boolean } = {}) {
  let t = Date.parse("2026-11-14T12:00:00Z");
  let i = 0;
  const sent: Array<Record<string, unknown>> = [];
  const block = (n: bigint, base: number) => ({ number: n, timestamp: BigInt(Math.floor(t / 1000)), baseFeePerGas: parseGwei(String(base)), transactions: [] as Hex[] });
  const client = {
    getBlock: async (a?: { blockNumber?: bigint }) => (a?.blockNumber !== undefined ? block(a.blockNumber, 10) : block(1000n + BigInt(i), bases[Math.min(i++, bases.length - 1)])),
    getBlockNumber: async () => 1000n,
    getGasPrice: async () => parseGwei("10"),
    getFeeHistory: async () => ({ reward: [[0n, 0n, 0n]], gasUsedRatio: [0.001] }),
    estimateGas: async () => 21000n,
    waitForTransactionReceipt: async () => ({ blockNumber: 1234n, gasUsed: 21000n, effectiveGasPrice: parseGwei(String(bases[Math.min(i - 1, bases.length - 1)])), status: "success" }),
  };
  const wallet = opts.wallet
    ? {
        account: { address: FROM },
        chain: undefined,
        sendTransaction: async (a: Record<string, unknown>) => {
          sent.push(a);
          return `0x${"ab".repeat(32)}` as Hex;
        },
      }
    : undefined;
  const dir = mkdtempSync(join(tmpdir(), "tide-"));
  const lines: string[] = [];
  const d: Deps = {
    client: client as never,
    wallet: wallet as never,
    net: NETWORKS.mainnet,
    store: new Store(dir),
    say: (l) => lines.push(l),
    now: () => new Date(t),
    sleep: async (ms) => {
      t += ms;
    },
    checkSeconds: 5,
  };
  return { d, sent, lines, done: () => rmSync(dir, { recursive: true, force: true }), clock: () => t };
}

test("holds while the base fee is over the line, sends when it drops, receipt saved", async () => {
  const w = world([12, 12, 12, 9], { wallet: true });
  const job = await newJob(w.d, { from: FROM, to: TO, value: 0n, deadline: new Date(w.clock() + 600_000), line: 10, hours: 1 });
  const done = await hold(w.d, job);
  assert.equal(done.status, "mined");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].maxPriorityFeePerGas, 0n);
  assert.equal(w.sent[0].maxFeePerGas, parseGwei("18"));
  assert.equal(done.went?.forced, false);
  assert.ok(w.lines.some((l) => l.startsWith("holding: base fee 12 gwei is over the line")));
  // what was saved on disk is the finished job
  assert.equal(w.d.store.jobs()[0].status, "mined");
  const text = receiptText(done, NETWORKS.mainnet);
  assert.match(text, /^mined in block 1234: https:\/\/www.pharosscan.xyz\/tx\/0xabab/);
  assert.match(text, /if sent right at request time \(base \+ tip then\): 12 gwei = 0\.00025200 PROS {2}\(you saved 0\.00006300 PROS, 25\.0%\)/);
  w.done();
});

test("never past the deadline: still over the line, it goes MARGIN seconds before", async () => {
  const w = world([15], { wallet: true });
  const deadline = new Date(w.clock() + 120_000);
  const done = await hold(w.d, await newJob(w.d, { from: FROM, to: TO, value: 0n, deadline, line: 10, hours: 1 }));
  assert.equal(done.went?.forced, true);
  assert.ok(Date.parse(done.went!.at) < deadline.getTime());
  assert.ok(deadline.getTime() - Date.parse(done.went!.at) <= MARGIN_SECONDS * 1000);
  assert.match(receiptText(done, NETWORKS.mainnet), /before the deadline/);
  w.done();
});

test("dry run stops where it would send and sends nothing", async () => {
  const w = world([10]);
  const done = await hold(w.d, await newJob(w.d, { from: FROM, to: TO, value: 0n, deadline: new Date(w.clock() + 600_000), hours: 1 }));
  assert.equal(done.status, "would-send");
  assert.equal(done.line, 10, "line from history: the lowest base fee seen");
  assert.equal(done.lineFrom, "history");
  assert.match(receiptText(done, NETWORKS.mainnet), /^dry run, nothing sent/);
  w.done();
});

test("a job that was sent before a restart only waits for its receipt", async () => {
  const w = world([10], { wallet: true });
  const job = await newJob(w.d, { from: FROM, to: TO, value: 0n, deadline: new Date(w.clock() + 600_000), hours: 1 });
  job.status = "sent";
  job.hash = `0x${"cd".repeat(32)}`;
  job.went = { at: new Date(w.clock()).toISOString(), why: "test", forced: false, sample: job.atRequest, maxFee: "0", tip: "0", gas: "25200" };
  const done = await hold(w.d, job);
  assert.equal(done.status, "mined");
  assert.equal(w.sent.length, 0, "not sent a second time");
  w.done();
});
