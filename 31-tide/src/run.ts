// The loop around one job: read gas, decide, wait, send, wait for the receipt. Every reading is saved, and the job
// is written after every step, so killing tide never loses track of a tx.
import type { Address, Hex, PublicClient, WalletClient } from "viem";
import { g, paid, past, sample, type Sample } from "./gas.js";
import { compare, decide, fees, fmtLeft, type Job } from "./hold.js";
import { txUrl, type Network } from "./net.js";
import type { Store } from "./store.js";

export interface Deps {
  client: PublicClient;
  wallet?: WalletClient; // none: a dry run that stops where it would send
  net: Network;
  store: Store;
  say: (line: string) => void;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  checkSeconds: number;
}

export async function newJob(d: Deps, o: { from: Address; to: Address; value: bigint; data?: Hex; deadline: Date; line?: number; hours: number }): Promise<Job> {
  const s = await sample(d.client, d.net, d.now());
  d.store.record(s);
  const since = new Date(d.now().getTime() - o.hours * 3_600_000).toISOString();
  const seen = [...(await past(d.client, d.net, o.hours, 24)).map((p) => p.base), ...d.store.samples(d.net.name, since).map((x) => x.base), s.base];
  const floor = Math.min(...seen);
  const job: Job = {
    id: `${d.now().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${o.to.slice(2, 8)}`,
    network: d.net.name,
    from: o.from,
    tx: { to: o.to, value: o.value.toString(), data: o.data },
    created: d.now().toISOString(),
    deadline: o.deadline.toISOString(),
    line: o.line ?? floor,
    lineFrom: o.line === undefined ? "history" : "you",
    atRequest: s,
    paidLately: await paid(d.client, 30),
    status: "holding",
    checks: 0,
  };
  d.store.save(job);
  d.say(`job ${job.id}: hold until base fee <= ${g(job.line)} (${job.lineFrom === "you" ? "your line" : `lowest base fee in the last ${o.hours} h`}), deadline ${job.deadline}`);
  d.say(`  at request: base ${g(s.base)}, eth_gasPrice ${g(s.gasPrice)}, tips lately p10/p50/p90 ${s.tips.p10}/${s.tips.p50}/${s.tips.p90} gwei`);
  return job;
}

async function go(d: Deps, job: Job, s: Sample, why: string, forced: boolean): Promise<void> {
  const f = fees(s, forced);
  const est = await d.client.estimateGas({ account: job.from, to: job.tx.to, value: BigInt(job.tx.value), data: job.tx.data });
  const gas = (est * 120n) / 100n;
  job.went = { at: d.now().toISOString(), why, forced, sample: s, maxFee: f.maxFeePerGas.toString(), tip: f.maxPriorityFeePerGas.toString(), gas: gas.toString() };
  if (!d.wallet) {
    job.status = "would-send";
    job.receipt = { block: s.block, gasUsed: est.toString(), effective: s.base + Number(f.maxPriorityFeePerGas) / 1e9, status: "success" };
    d.say(`dry run: would send now (${why}), gas limit ${gas}, estimate ${est}`);
    return;
  }
  job.hash = await d.wallet.sendTransaction({
    account: d.wallet.account!,
    chain: d.wallet.chain,
    to: job.tx.to,
    value: BigInt(job.tx.value),
    data: job.tx.data,
    gas,
    maxFeePerGas: f.maxFeePerGas,
    maxPriorityFeePerGas: f.maxPriorityFeePerGas,
  });
  job.status = "sent";
  d.store.save(job);
  d.say(`sent ${job.hash} (${why})`);
  d.say(`  ${txUrl(d.net, job.hash)}`);
}

export async function hold(d: Deps, job: Job): Promise<Job> {
  let last = "";
  while (job.status === "holding") {
    const s = await sample(d.client, d.net, d.now());
    d.store.record(s);
    job.checks++;
    const dec = decide(s, job, d.now());
    if (dec.go) {
      await go(d, job, s, dec.why, dec.forced);
      d.store.save(job);
      break;
    }
    // one line when something changes, otherwise one a minute
    const key = `${s.base}`;
    if (key !== last || job.checks % Math.max(1, Math.round(60 / d.checkSeconds)) === 0) d.say(`holding: ${dec.why} (block ${s.block})`);
    last = key;
    d.store.save(job);
    await d.sleep(d.checkSeconds * 1000);
  }
  if (job.status === "sent" && job.hash) {
    const r = await d.client.waitForTransactionReceipt({ hash: job.hash, timeout: 180_000 });
    job.receipt = { block: String(r.blockNumber), gasUsed: r.gasUsed.toString(), effective: Number(r.effectiveGasPrice) / 1e9, status: r.status };
    job.status = r.status === "success" ? "mined" : "reverted";
    d.store.save(job);
  }
  return job;
}

export function receiptText(job: Job, net: Network): string {
  if (!job.receipt || !job.went) return `job ${job.id}: ${job.status}`;
  const c = compare(job, job.receipt.effective, BigInt(job.receipt.gasUsed));
  const late = Date.parse(job.went.at) - Date.parse(job.deadline);
  const held = (Date.parse(job.went.at) - Date.parse(job.created)) / 1000;
  const p = (x: number) => `${x.toFixed(8)} PROS`;
  const lines = [
    job.status === "would-send" || !job.hash ? "dry run, nothing sent" : `${job.status} in block ${job.receipt.block}: ${txUrl(net, job.hash)}`,
    `  held ${fmtLeft(held)} over ${job.checks} checks, sent ${late > 0 ? `${fmtLeft(late / 1000)} AFTER` : `${fmtLeft(-late / 1000)} before`} the deadline`,
    `  why then: ${job.went.why}`,
    `  paid ${g(c.paid)} per gas × ${c.gasUsed} gas = ${p((c.paid * Number(c.gasUsed)) / 1e9)}${job.status === "would-send" ? " (estimate)" : ""}`,
    ...c.rows.map((r) => `  ${r.what}: ${g(r.gwei)} = ${p(r.pros)}  (${r.vsPaid > 1e-12 ? `you saved ${p(r.vsPaid)}, ${((r.vsPaid / r.pros) * 100).toFixed(1)}%` : r.vsPaid < -1e-12 ? `you paid ${p(-r.vsPaid)} more` : "the same"})`),
  ];
  return lines.join("\n");
}
