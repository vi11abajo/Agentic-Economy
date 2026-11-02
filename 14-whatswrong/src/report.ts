// Turns the findings into a short sheet of facts. It's written for the agent to read, not for the end user:
// the agent explains it in plain words, in the user's language. So: facts, no prose, nothing guessed.
import type { Autopsy, TokenAmount } from "./autopsy.js";
import type { Revert } from "./clues.js";
import type { Remedy } from "./remedy.js";

const EXPLORER = "https://www.pharosscan.xyz/tx/";
const short = (address?: string | null) => (address ? `${address.slice(0, 6)}…${address.slice(-4)}` : "?");
const voice = (revert?: Revert) =>
  !revert ? "-" : revert.name === "silence" ? "(no reason given)" : revert.message ? `${revert.name}("${revert.message}")` : revert.name === "unknown" ? `unknown error ${revert.selector}` : revert.name;
const amount = (value: unknown) => (value && typeof value === "object" && "pretty" in value ? (value as TokenAmount).pretty : String(value));

export function factSheet(verdict: Autopsy, fix?: Remedy): string {
  const lines: string[] = [];
  const say = (label: string, text: string) => lines.push(`${label.padEnd(18)} ${text}`);

  say("tx", `${verdict.hash} (block ${verdict.block}) ${EXPLORER}${verdict.hash}`);
  if (verdict.kind === "not_failed") {
    say("status", "succeeded: nothing failed here");
    return lines.join("\n");
  }
  const target = verdict.tx.to ?? "(a new contract)";
  say("status", `FAILED, ${verdict.kind === "deployment_failed" ? "contract deployment" : (verdict.calledFunction ?? verdict.tx.input.slice(0, 10))} on ${target}, from ${verdict.tx.from}`);
  if (verdict.where && verdict.where.depth > 0) {
    const route = verdict.where.path.map((frame) => short(frame.to)).filter((hop, i, all) => hop !== all[i - 1]).join(" -> ");
    say("broke at", `${verdict.where.depth} call(s) deep: ${verdict.brokenFunction ?? verdict.where.input.slice(0, 10)} on ${verdict.where.to} (${route})`);
  }
  say("said", voice(verdict.said) + (verdict.deepest && verdict.deepest.name !== verdict.said.name ? `; deepest: ${voice(verdict.deepest)}` : ""));
  say("kind", verdict.kind);
  say("gas", `used ${verdict.gasUsed} of ${verdict.gasLimit}`);

  const facts = verdict.facts as Record<string, unknown>;
  if (facts.owner) say("owner", String(facts.owner));
  for (const key of ["needed", "balance", "allowance", "wanted", "cash"]) if (facts[key] !== undefined) say(key, amount(facts[key]));
  if (facts.spender) say("spender", String(facts.spender));
  if (facts.payer) say("payer", String(facts.payer));
  if (facts.alsoShort) say("also short", String(facts.alsoShort));
  if (facts.blockTime) say("block time", `${facts.blockTime} (${new Date(Number(facts.blockTime) * 1000).toISOString()})`);
  const moved = facts.alreadyMoved as { tx: string; block: number; blocksEarlier: number } | undefined;
  if (moved) say("left before", `the same amount went to the same place ${moved.blocksEarlier} blocks earlier, ${EXPLORER}${moved.tx}`);
  if (verdict.kind === "same_block") {
    if (!verdict.neighbours?.length) say("same block", "no earlier transaction in this block touched the same contract or came from the same sender");
    for (const n of verdict.neighbours ?? []) say("same block", `#${n.index} ${EXPLORER}${n.hash} from ${n.from}${n.sameSender ? " (the same sender)" : ""} -> ${n.to}`);
  }

  if (fix) {
    if (verdict.kind !== "deployment_failed") say("now", fix.wouldPassNow ? "the same tx, unchanged, would go through right now" : `the same tx, unchanged, still fails right now: ${voice(fix.nowSays)}`);
    if (fix.check) {
      const label = fix.check.how === "replayed" ? (fix.check.passes ? "fix works" : "fix fails") : fix.check.passes ? "looked up: ok" : "looked up: short";
      say(label, fix.check.tried);
      for (const [key, value] of Object.entries(fix.check.numbers ?? {})) say(`  ${key}`, String(value));
      if (fix.check.nextProblem) say("  then", voice(fix.check.nextProblem));
    }
    for (const note of fix.notes) say("note", note);
  }
  return lines.join("\n");
}

/** JSON with bigints as strings, for scripts and the --json flag. */
export const asJson = (verdict: Autopsy, fix?: Remedy) =>
  JSON.stringify({ ...verdict, fix }, (_, value) => (typeof value === "bigint" ? value.toString() : value), 2);
