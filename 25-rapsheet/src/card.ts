// The record as people read it: in the terminal, and as Markdown you can paste into a chat or a ticket.
import type { Finding, Level } from "./finding.js";
import { short } from "./finding.js";
import type { Report } from "./rapsheet.js";

const TAG: Record<Level, string> = { high: "HIGH", medium: "MEDIUM", ok: "ok", info: "note", unchecked: "not checked" };
const ORDER: Level[] = ["high", "medium", "info", "ok", "unchecked"];
const SOURCE = { chain: "read from the chain", explorer: "from the explorer", "chain+explorer": "explorer, checked on the chain", you: "from your own history" };

const when = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

function sorted(r: Report): Finding[] {
  // "what it is" always leads; the rest worst first
  const rank = (f: Finding) => (f.id === "kind" ? -1 : ORDER.indexOf(f.level));
  return [...r.findings].sort((a, b) => rank(a) - rank(b));
}

export function card(r: Report): string {
  const lines: string[] = [];
  const what = r.kind === "contract" ? `contract${r.name ? ` "${r.name}"` : ""}` : "wallet";
  lines.push(`rapsheet for ${r.target} (${what})`);
  lines.push(`Pharos mainnet, head block ${r.head}, ${when(r.time)}${r.me ? `, asked by ${r.me}` : ""}`);
  lines.push("");
  for (const f of sorted(r)) {
    lines.push(`  ${TAG[f.level].padEnd(11)} ${f.title}`);
    lines.push(`              ${f.said}`);
    if (f.why) lines.push(`              Why it matters: ${f.why}`);
    if (f.easing) lines.push(`              On the other hand: ${f.easing}`);
    lines.push(`              (${SOURCE[f.source]}) ${f.evidence.map((e) => `${e.label} ${e.url}`).join("  ")}`);
  }
  lines.push("");
  const v = r.verdict;
  lines.push(`RISK: ${v.risk}${v.reasons.length ? ` - ${v.reasons.length} red flag${v.reasons.length === 1 ? "" : "s"}` : " - no red flags"}`);
  v.reasons.forEach((f, i) => lines.push(`  ${i + 1}. [${TAG[f.level]}] ${f.said}`));
  if (v.unchecked.length) lines.push(`Not checked: ${v.unchecked.map((f) => f.title.toLowerCase()).join("; ")}.`);
  lines.push("Rule: one HIGH flag or three MEDIUM flags make it HIGH; one or two MEDIUM make it MEDIUM. Red flags are reasons to stop and look, not proof of a crime.");
  return lines.join("\n");
}

export function markdown(r: Report): string {
  const out: string[] = [];
  const v = r.verdict;
  out.push(`# rapsheet: ${short(r.target)} is ${v.risk} risk`);
  out.push("");
  out.push(`[${r.target}](https://www.pharosscan.xyz/address/${r.target}), ${r.kind}${r.name ? ` "${r.name}"` : ""}. Pharos mainnet, head block ${r.head}, ${when(r.time)}.`);
  out.push("");
  if (v.reasons.length) {
    out.push("## Red flags");
    out.push("");
    v.reasons.forEach((f, i) => out.push(`${i + 1}. **${TAG[f.level]}**: ${f.said} ${f.why}`));
    out.push("");
  }
  out.push("## The whole record");
  out.push("");
  out.push("| | Check | What we saw | Evidence |");
  out.push("|---|---|---|---|");
  for (const f of sorted(r)) {
    const said = (f.said + (f.easing ? ` *${f.easing}*` : "")).replace(/\|/g, "\\|");
    out.push(`| ${TAG[f.level]} | ${f.title} | ${said} | ${f.evidence.map((e) => `[${e.label}](${e.url})`).join(", ")} (${SOURCE[f.source]}) |`);
  }
  out.push("");
  out.push("One HIGH flag or three MEDIUM flags make it HIGH; one or two MEDIUM make it MEDIUM. Red flags are reasons to stop and look, not proof of a crime.");
  return out.join("\n") + "\n";
}
