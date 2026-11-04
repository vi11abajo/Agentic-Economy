// How a verdict reads: the answer first (ALLOW, or DENY and the rule that decided), then every rule that ran.
// The agent shows this to the user as is, so it has to make sense to someone who never read the policy file.
import { formatUnits } from "viem";
import type { Verdict } from "./gate.js";

export function renderVerdict(v: Verdict): string {
  const head = v.decision === "allow" ? "ALLOW" : v.decision === "deny" ? `DENY by ${v.rule}: ${v.reason}` : `ERROR (nothing was let through): ${v.reason}`;
  const lines = [head, `  request: ${v.request.words}`];
  if (v.block !== null) lines.push(`  judged on mainnet block ${v.block}`);
  for (const c of v.checks) lines.push(`  ${c.ok ? "✓" : "✗"} ${c.rule.padEnd(13)} ${c.reason}`);
  if (v.decision === "allow" && v.gasLimit && v.maxFee) lines.push(`  gas: up to ${v.gasLimit.toLocaleString("en-US")} units, at most ${formatUnits(v.gasLimit * v.maxFee, 18)} PROS`);
  return lines.join("\n");
}

export function verdictJson(v: Verdict): string {
  return JSON.stringify(
    {
      decision: v.decision,
      rule: v.rule,
      reason: v.reason,
      checks: v.checks.map(({ rule, ok, reason, hop }) => ({ rule, ok, reason, ...(hop ? { hop: { address: hop.address, depth: hop.depth, path: hop.path } } : {}) })),
      request: v.request.words,
      tx: v.tx ?? { from: null, ...v.request.tx },
      block: v.block,
      gasLimit: v.gasLimit,
      maxFee: v.maxFee,
      policyHash: v.policyHash,
    },
    (_, x) => (typeof x === "bigint" ? x.toString() : x),
    2,
  );
}
