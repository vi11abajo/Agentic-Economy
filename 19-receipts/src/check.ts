// The "show me the receipt" check. The agent writes its answer in plain words; before it goes to the user we
// read it back line by line, find every number, and make sure each one is a fact the scan actually produced
// (or simple arithmetic on facts cited in the same line). A number that came from nowhere fails the answer.
import type { Fact } from "./facts.js";

const CITATION = /\[(F\d+(?:\s*,\s*F\d+)*)\]/g;
// A figure is a number standing on its own: not glued to letters (ERC-4626, x402, p3QMV), not part of a hex.
const FIGURE = /(?<![\w.\-])-?\$?\d[\d,]*(?:\.\d+)?(?![\w]|\.\d)%?/g;
const TOLERANCE = 0.005; // half a percent covers "about" and rounding to a few digits

/** Things that look like numbers but are addresses, hashes, block heights, dates or list markers. */
function stripNonFigures(line: string): string {
  return line
    .replace(CITATION, " ")
    .replace(/0x[0-9a-fA-F]+/g, " ")
    .replace(/\bblocks?\s+#?[\d,]+(?:\s*(?:to|-|\.\.)\s*#?[\d,]+)?/gi, " ")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+Z?)?/g, " ")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, " ")
    .replace(/^\s*(?:[-*]\s*)?\d+[.)]\s+/, " ");
}

function shownDecimals(text: string): number {
  const dot = text.indexOf(".");
  return dot < 0 ? 0 : text.length - dot - 1;
}

/** The values a line may legitimately show given the facts it cites: each fact, and simple sums and ratios. */
function allowedValues(cited: number[]): number[] {
  const out = [...cited];
  if (cited.length > 1) out.push(cited.reduce((a, b) => a + b, 0));
  for (let i = 0; i < cited.length; i++) {
    for (let j = 0; j < cited.length; j++) {
      if (i === j) continue;
      const a = cited[i], b = cited[j];
      out.push(a + b, a - b, a * b);
      if (b !== 0) out.push(a / b, (a / b) * 100, ((a - b) / b) * 100);
    }
  }
  return out;
}

function close(shown: number, allowed: number, decimals: number): boolean {
  const diff = Math.abs(shown - allowed);
  return diff <= Math.abs(allowed) * TOLERANCE || diff <= 0.5 * 10 ** -decimals + 1e-12;
}

export function checkAnswer(text: string, facts: Fact[]): { ok: boolean; problems: string[] } {
  const byId = new Map(facts.map((f) => [f.id, f]));
  const problems: string[] = [];
  for (const [n, line] of text.split(/\r?\n/).entries()) {
    const ids = [...line.matchAll(CITATION)].flatMap((m) => m[1].split(/\s*,\s*/));
    const cited: Fact[] = [];
    for (const id of ids) {
      const fact = byId.get(id);
      if (fact) cited.push(fact);
      else problems.push(`line ${n + 1}: ${id} does not exist`);
    }
    const values = allowedValues(cited.map((f) => Number(f.value)).filter((v) => Number.isFinite(v)));
    for (const m of stripNonFigures(line).matchAll(FIGURE)) {
      const token = m[0].replace(/[$%,]/g, "");
      const shown = Number(token);
      if (!Number.isFinite(shown)) continue;
      if (!cited.length) {
        problems.push(`line ${n + 1}: ${m[0]} has no fact id`);
        continue;
      }
      const decimals = shownDecimals(token);
      const ok = values.some((v) => close(shown, v, decimals) || close(shown, Math.abs(v), decimals));
      if (!ok) {
        const listed = cited.map((f) => `${f.id} (${f.value})`).join(", ");
        problems.push(`line ${n + 1}: ${m[0]} does not match ${listed}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
