// The check as a person reads it: one line per action, what Multicall3 keeps (should be nothing), the
// comparison with doing it one by one, warnings, and whether it's ready to send.
import { fmt, type CheckReport } from "./check.js";

const pct = (a: bigint, b: bigint) => {
  const p = (Number(a - b) / Number(b)) * 100;
  return `${p > 0 ? "+" : ""}${p.toFixed(2)}%`;
};

export function renderCheck(r: CheckReport): string {
  const lines: string[] = [];
  lines.push(`onego check: ${r.results.length} actions from ${r.wallet}, in one transaction`, "");
  const width = Math.max(...r.results.map((x) => x.label.length), 6);
  for (const x of r.results) {
    const what = x.ok ? `ok${x.got ? `, gets ${fmt(x.got.amount, x.got.decimals)} ${x.got.symbol}` : ""}` : `FAILS: ${x.reason}`;
    lines.push(`${String(x.action + 1).padStart(3)}  ${x.label.padEnd(width)}  ${what}`);
  }
  lines.push("");
  lines.push(`Left in Multicall3 after the batch: ${r.leftovers.length ? r.leftovers.map((l) => `${fmt(l.amount, 18)} ${l.symbol}`).join(", ") : "nothing"}`);
  lines.push(`PROS sent with the transaction: ${fmt(r.batch.value, 18)}`);
  if (r.batch.gas !== null) {
    lines.push(
      `Batch vs one by one: 1 transaction instead of ${r.oneByOne.txs}; ${r.batch.gas.toLocaleString("en-US")} gas vs ${r.oneByOne.gas.toLocaleString("en-US")} (${pct(r.batch.gas, r.oneByOne.gas)}); fee about ${fmt(r.batch.feePros ?? 0n, 18)} PROS vs ${fmt(r.oneByOne.feePros, 18)} PROS`,
    );
  } else lines.push(`Batch vs one by one: the batch would revert, so there's no gas number (${r.oneByOne.txs} transactions one by one)`);
  for (const w of r.warnings) lines.push(`Warning: ${w}`);
  lines.push("");
  lines.push(r.sendable ? "Verdict: ready to send" : `Verdict: NOT sendable\n${r.refusals.map((x) => `  - ${x}`).join("\n")}`);
  return lines.join("\n");
}
