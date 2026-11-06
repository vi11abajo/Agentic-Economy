// Plain-text report of a look. Numbers carry their unit; rates say which rate they are.
import { formatUnits } from "viem";
import type { Look } from "./look.js";
import { LANE_DECIMALS } from "./venues.js";

const pct = (x?: number) => (x === undefined ? "-" : `${(x * 100).toFixed(2)}%`);
const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + " " : s + " ".repeat(n - s.length));
const num = (x: number | undefined, d = 6) => (x === undefined ? "-" : Number(x.toFixed(d)).toString());

export function render(l: Look): string {
  const u = l.lane;
  const dec = LANE_DECIMALS[u];
  const amt = (x: bigint) => `${Number(Number(formatUnits(x, dec)).toPrecision(6))} ${u}`;
  const lines: string[] = [];
  lines.push(`dent  ${u} lane  wallet ${l.wallet}`);
  lines.push(`block ${l.block} (${l.at}); 7-day window from block ${l.windows.d7}, 30-day from ${l.windows.d30}`);
  lines.push("");
  lines.push(pad("place", 32) + pad("you hold", 16) + pad("now", 8) + pad("with you", 10) + pad("7d real", 9) + pad("30d real", 10) + "status");
  for (const r of l.readings) {
    const status = r.status === "open" ? "open" : `${r.status}: ${r.why}`;
    lines.push(
      pad(r.source.name, 32) +
        pad(r.held > 0n ? amt(r.held) : "-", 16) +
        pad(pct(r.rateNow), 8) +
        pad(pct(r.rateWithYou), 10) +
        pad(pct(r.realized7d), 9) +
        pad(pct(r.realized30d), 10) +
        status,
    );
  }
  lines.push("");
  const d = l.decision;
  lines.push(`moving ${num(d.amount)} ${u} out of ${d.from.name}, credited ${pct(d.from.rateUsed)} (${d.from.rateHow}); hold ${d.holdDays} days; minimum gain ${d.minGain} ${u}`);
  lines.push(`gas price ${Number(formatUnits(BigInt(l.gasPriceWei), 9))} gwei${l.prosUsd ? `; PROS = $${l.prosUsd.usd.toFixed(4)} (Chainlink, updated ${new Date(l.prosUsd.updatedAt * 1000).toISOString()})` : ""}`);
  for (const o of d.options) {
    if (o.verdict === "skip") {
      lines.push(`  - ${o.name}: skipped, ${o.why}`);
      continue;
    }
    lines.push(
      `  - ${o.name}: ${pct(o.rateUsed)} (${o.rateHow}); extra yield ${num(o.extraYield)} - fees ${num(o.fees)} - gas ${num(o.gas)} = net ${num(o.net)} ${u}; break-even ${o.breakEvenDays ?? "never"}${o.breakEvenDays !== null ? " days" : ""}. ${o.why}`,
    );
  }
  lines.push("");
  lines.push(d.action === "MOVE" ? `MOVE to ${d.reason}` : `STAY PUT: ${d.reason}`);
  for (const n of l.notes) lines.push(`note: ${n}`);
  for (const r of l.readings) for (const n of r.notes) lines.push(`note (${r.source.name}): ${n}`);
  if (l.plan) {
    lines.push("");
    lines.push(`transactions for YOUR wallet to sign (dent holds no key):`);
    l.plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. [phase ${s.phase}] ${s.says} -> ${s.to}  gas ${s.gas ?? "?"} (${s.gasHow})`));
    if (l.plan.waitSeconds) lines.push(`  phase 2 opens ${l.plan.waitSeconds / 3600} h after phase 1 lands`);
  }
  return lines.join("\n");
}
