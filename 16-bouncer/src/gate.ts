// gate(): one request in, one decision out, one line in the audit log. It reads everything at a single block
// (one behind the head, since a load-balanced RPC may not have the newest block on every node yet), so the
// trace, the gas estimate, the balance and the code checks all describe the same moment.
import type { Address, Hex } from "viem";
import { appendEntry, readLog, spentSince } from "./audit.js";
import type { Chain, TxReq } from "./chain.js";
import { loadPolicy } from "./policy.js";
import type { Request } from "./request.js";
import { checkTimeWindow, judge, type Check, type RuleId, type Situation } from "./rules.js";
import { readTrace, type Facts } from "./trace.js";

export type Verdict = {
  decision: "allow" | "deny" | "error";
  rule: RuleId | null;
  reason: string;
  checks: Check[];
  request: Request;
  /** the exact unsigned tx that was judged, `from` included */
  tx: TxReq | null;
  block: bigint | null;
  gasLimit: bigint | null;
  maxFee: bigint | null;
  facts: Facts | null;
  policyHash: Hex | null;
};

const DAY_MS = 24 * 3600_000;
const plainChecks = (checks: Check[]) => checks.map(({ rule, ok, reason }) => ({ rule, ok, reason }));
const plainTx = (tx: { to: Address; data: Hex; value: bigint }) => ({ ...tx, value: tx.value.toString() });

async function record(home: string, v: Verdict, now: Date): Promise<Verdict> {
  const request = { words: v.request.words, tx: plainTx(v.request.tx) };
  if (v.decision === "error") await appendEntry(home, { kind: "error", request, message: v.reason }, now);
  else await appendEntry(home, { kind: "decision", request, policyHash: v.policyHash, block: v.block?.toString() ?? null, decision: v.decision, rule: v.rule, reason: v.reason, checks: plainChecks(v.checks) }, now);
  return v;
}

export async function gate(chain: Chain, home: string, request: Request, opts: { now: Date }): Promise<Verdict> {
  const blank: Verdict = { decision: "deny", rule: null, reason: "", checks: [], request, tx: null, block: null, gasLimit: null, maxFee: null, facts: null, policyHash: null };

  const loaded = loadPolicy(home);
  if ("problems" in loaded) {
    const reason = `the policy can't be used until it's fixed: ${loaded.problems.join("; ")}`;
    return record(home, { ...blank, rule: "policy", reason, checks: [{ rule: "policy", ok: false, reason }] }, opts.now);
  }
  const { policy, hash } = loaded;
  const base = { ...blank, policyHash: hash };

  // The clock needs no network: outside the window we don't even ask the chain.
  const clock = checkTimeWindow({ policy, now: opts.now } as Situation);
  if (!clock.ok) return record(home, { ...base, rule: "time_window", reason: clock.reason, checks: [clock] }, opts.now);

  const tx: TxReq = { from: policy.wallet, to: request.tx.to, data: request.tx.data, value: request.tx.value };
  try {
    const block = (await chain.blockNumber()) - 1n;
    const frame = await chain.trace(tx, block);
    const estimate = await chain.estimateGas(tx, block);
    const gasPrice = await chain.gasPrice();
    const balance = await chain.balance(policy.wallet, block);
    const facts = readTrace(frame, policy.wallet);
    // A trace that ran fine but no gas amount makes it pass is still a tx that would fail.
    if (estimate === null && !facts.reverted) facts.reverted = { reason: "the node can't find a gas amount that lets it through" };
    const gasLimit = estimate === null ? null : (estimate * 12n) / 10n;
    const maxFee = gasPrice * 2n;

    const withCode = new Set<Address>();
    for (const a of new Set(facts.hops.map((h) => h.address))) if ((await chain.code(a, block)) !== "0x") withCode.add(a);

    const log = readLog(home);
    const spentToday = log.brokenAt !== null ? { broken: `the audit log is broken at line ${log.brokenAt} (run "bouncer log --verify")` } : spentSince(log.entries, new Date(opts.now.getTime() - DAY_MS), policy);

    const situation: Situation = { policy, now: opts.now, facts, hasCode: (a) => withCode.has(a), value: tx.value, balance, worstGas: (gasLimit ?? 0n) * maxFee, spentToday };
    const j = judge(situation);
    return record(home, { ...base, ...j, tx, block, gasLimit, maxFee, facts }, opts.now);
  } catch (err) {
    return record(home, { ...base, decision: "error", tx, reason: `couldn't check it against the chain: ${(err as Error).message}` }, opts.now);
  }
}
