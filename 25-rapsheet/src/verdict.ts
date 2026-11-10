// The level is a plain count, written down so anyone can redo it by hand: one HIGH flag, or three MEDIUM ones, is
// HIGH; one or two MEDIUM is MEDIUM; nothing flagged is LOW. Easing notes are shown but never change the count.
import type { Finding } from "./finding.js";

export type Risk = "LOW" | "MEDIUM" | "HIGH";

export interface Verdict {
  risk: Risk;
  /** The flags behind the level, worst first. */
  reasons: Finding[];
  /** What we couldn't look at, so a LOW is never read as "checked everything". */
  unchecked: Finding[];
}

export function verdict(findings: Finding[]): Verdict {
  const high = findings.filter((f) => f.level === "high");
  const medium = findings.filter((f) => f.level === "medium");
  const risk: Risk = high.length > 0 || medium.length >= 3 ? "HIGH" : medium.length > 0 ? "MEDIUM" : "LOW";
  return { risk, reasons: [...high, ...medium], unchecked: findings.filter((f) => f.level === "unchecked") };
}

/** Exit code for scripts and other agents: 0 low, 1 medium, 2 high. 3 is left for "couldn't run". */
export const exitCode = (r: Risk) => (r === "HIGH" ? 2 : r === "MEDIUM" ? 1 : 0);
