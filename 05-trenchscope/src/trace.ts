// The decision trace: every check with its value, its limit, pass/fail and where the number came from,
// then the verdict. Plain text the agent can paste into the chat as is.
import type { MarketSnapshot } from "./chain.js";
import type { Check, Decision } from "./checks.js";
import { short } from "./prosper.js";

const useColor = () => process.stdout.isTTY || process.env.TRENCHSCOPE_COLOR === "1";
const paint = (code: string, s: string) => (useColor() ? `\x1b[${code}m${s}\x1b[0m` : s);
const green = (s: string) => paint("32", s);
const red = (s: string) => paint("31", s);
const yellow = (s: string) => paint("33", s);
const dim = (s: string) => paint("2", s);
const bold = (s: string) => paint("1", s);

function mark(c: Check, side: "buy" | "sell"): string {
  if (c.ok === null) return yellow("? n/a");
  if (c.advisory) return c.ok ? green("ok") : yellow("! ask");
  if (side === "buy") return c.ok ? green("✓ pass") : red("✗ fail");
  return c.ok ? green("· quiet") : red("✗ EXIT");
}

export function utc(ts: number): string {
  return new Date(ts * 1000).toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export function renderTrace(s: MarketSnapshot, d: Decision, title: string): string {
  const rows = d.checks.map((c) => [c.advisory ? `${c.label} (advice)` : c.label, c.value, c.limit, mark(c, d.side), c.source]);
  const w = [0, 1, 2].map((i) => Math.max(...rows.map((r) => r[i].length), ["check", "value", "limit"][i].length));
  const line = (r: string[]) => `  ${r[0].padEnd(w[0])}  ${r[1].padEnd(w[1])}  ${r[2].padEnd(w[2])}  ${r[3]}`;
  const out = [
    bold(`trenchscope · ${title} · ${s.name} (${s.symbol})`),
    dim(`market ${short(s.market)} · token ${short(s.token)} · block ${s.block.toLocaleString("en-US")} · ${utc(s.timestamp)}`),
    "",
    dim(line(["check", "value", "limit", "result"])),
    ...rows.map((r) => `${line(r)}  ${dim(r[4])}`),
    "",
  ];
  const v = d.verdict;
  const tag = d.needsApproval ? yellow(v) : v === "APE" || v === "HOLD" ? green(v) : red(v);
  out.push(`${bold("VERDICT")}  ${tag}: ${d.reason}`);
  if (d.needsApproval) out.push(yellow("         advice flagged: ask the user before trading (run with --approve only after a clear yes)"));
  return out.join("\n");
}
