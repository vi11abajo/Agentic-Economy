// The "show me the receipt" check. The agent writes its answer in plain words; before it goes to the user we
// read it back line by line, find every number, and make sure each one is a fact the scan actually produced
// (or simple arithmetic on facts cited in the same line). A number that came from nowhere fails the answer.
import type { Fact } from "./facts.js";

const CITATION = /\[(F\d+(?:\s*,\s*F\d+)*)\]/g;
// A figure is a number that doesn't start inside a word (x402, p3QMV, ERC-4626 are names, not figures). What comes
// after it doesn't matter: "$9.9k", "5M", "7000USD" are figures too, and k/M/B scale them.
const FIGURE = /(?<![\w.])(?<![A-Za-z]-)-?\$?\d[\d,]*(?:\.\d+)?(?!\.\d)(?:([kKmMbB])(?![A-Za-z]))?%?/g;
const SCALE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9 };
const TOLERANCE = 0.005; // half a percent covers "about" and rounding to a few digits
// A negative fact may be shown without its minus only when the words around it already say it's a loss.
const LOSS_WORDS = /\b(loss|losses|lost|losing|down|lower|less|fell|dropped|decrease[ds]?|negative|minus|cost you)\b/i;
const NUMBER_IN_LABEL = /(?<![\w.])\d[\d,]*(?:\.\d+)?(?![\w.])/g;

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
    // Amounts a fact names in its own label ("bought 12.5 FOO for") came off the same receipt; they may be shown too.
    for (const f of cited) for (const lm of f.label.matchAll(NUMBER_IN_LABEL)) values.push(Number(lm[0].replace(/,/g, "")));
    const saysLoss = LOSS_WORDS.test(line);
    for (const m of stripNonFigures(line).matchAll(FIGURE)) {
      const token = m[0].replace(/[$%,kKmMbB]/g, "");
      const shown = Number(token) * (m[1] ? SCALE[m[1].toLowerCase()] : 1);
      if (!Number.isFinite(shown)) continue;
      if (!cited.length) {
        problems.push(`line ${n + 1}: ${m[0]} has no fact id`);
        continue;
      }
      const decimals = shownDecimals(token) - (m[1] ? Math.log10(SCALE[m[1].toLowerCase()]) : 0);
      const ok = values.some((v) => close(shown, v, decimals) || (v < 0 && shown > 0 && saysLoss && close(shown, -v, decimals)));
      if (!ok) {
        const listed = cited.map((f) => `${f.id} (${f.value})`).join(", ");
        problems.push(`line ${n + 1}: ${m[0]} does not match ${listed}`);
      }
    }
  }
  return { ok: problems.length === 0, problems };
}
