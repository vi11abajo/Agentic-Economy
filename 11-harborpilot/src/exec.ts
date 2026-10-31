// A plan is a list of unsigned transactions. Before anything is signed the whole plan is simulated, step by
// step, each one on top of what the earlier ones leave behind. Sending signs one step at a time, simulates it
// again on the live state right before it, and stops at the first one that would fail or did fail.
import { formatEther, keccak256, type Account, type Address, type Hex, type PublicClient, type StateOverride } from "viem";
import { EXPLORER, mergeOverrides, simulate, type Step } from "./chain.js";

export interface StepCheck {
  step: Step;
  ok: boolean;
  reason?: string;
  gas?: bigint;
}

export interface SentStep {
  step: Step;
  hash: Hex;
  status: "success" | "reverted" | "not mined";
  block?: bigint;
  gasUsed?: bigint;
}

/** Simulate every step in order from `from`; a step's `after` overrides apply to the steps behind it. */
export async function checkPlan(client: PublicClient, from: Address, steps: Step[], base: StateOverride = []): Promise<StepCheck[]> {
  const out: StepCheck[] = [];
  let acc: StateOverride = base;
  let failed = false;
  for (const step of steps) {
    if (failed) {
      out.push({ step, ok: false, reason: "not checked: an earlier step fails" });
      continue;
    }
    const r = await simulate(client, from, step, acc.length ? acc : undefined);
    out.push(r.ok ? { step, ok: true } : { step, ok: false, reason: r.reason });
    if (!r.ok) failed = true;
    if (step.after) acc = mergeOverrides(acc, step.after);
  }
  return out;
}

async function waitReceipt(client: PublicClient, hash: Hex, ms: number) {
  const until = Date.now() + ms;
  for (;;) {
    const r = await client.getTransactionReceipt({ hash }).catch(() => null);
    if (r || Date.now() >= until) return r;
    await new Promise((res) => setTimeout(res, 1500));
  }
}

export interface SendOptions {
  log: (line: string) => void;
  gasBufferPct: number;
}

/**
 * Sign and send the steps one by one. Each one is simulated again on the live chain first: if it would fail
 * now, nothing more is sent. The nonce is counted here, because right after a receipt a load-balanced node can
 * still report the old one.
 */
export async function sendPlan(client: PublicClient, account: Account, steps: Step[], o: SendOptions): Promise<{ sent: SentStep[]; stopped?: string }> {
  const from = account.address;
  const sent: SentStep[] = [];
  let nonce = await client.getTransactionCount({ address: from, blockTag: "pending" });
  for (const [i, step] of steps.entries()) {
    const n = `${i + 1}/${steps.length}`;
    const sim = await simulate(client, from, step);
    if (!sim.ok) return { sent, stopped: `step ${n} (${step.label}) would fail now: ${sim.reason}. Nothing more was sent.` };
    const estimate = await client.estimateGas({ account: from, to: step.to, data: step.data, value: step.value });
    const gas = (estimate * BigInt(100 + o.gasBufferPct)) / 100n;
    const gasPrice = await client.getGasPrice();
    const raw = await account.signTransaction!({ chainId: 1672, type: "eip1559", to: step.to, data: step.data, value: step.value, gas, maxFeePerGas: (gasPrice * 3n) / 2n, maxPriorityFeePerGas: 0n, nonce });
    let hash = keccak256(raw);
    try {
      hash = await client.sendRawTransaction({ serializedTransaction: raw });
    } catch (e) {
      return { sent, stopped: `step ${n} (${step.label}) was refused by the node: ${(e as Error).message.split("\n")[0]}` };
    }
    o.log(`  ${n} sent      ${step.label}\n            ${EXPLORER}/tx/${hash}`);
    const rc = await waitReceipt(client, hash, 90_000);
    if (!rc) {
      sent.push({ step, hash, status: "not mined" });
      return { sent, stopped: `step ${n} not mined within 90 s; check ${EXPLORER}/tx/${hash} before running again` };
    }
    sent.push({ step, hash, status: rc.status, block: rc.blockNumber, gasUsed: rc.gasUsed });
    o.log(`      ${rc.status === "success" ? "done" : "REVERTED"}  block ${rc.blockNumber.toLocaleString("en-US")}, gas ${formatEther(rc.gasUsed * rc.effectiveGasPrice)} PROS`);
    if (rc.status !== "success") return { sent, stopped: `step ${n} reverted on chain; nothing more was sent` };
    nonce++;
  }
  return { sent };
}
