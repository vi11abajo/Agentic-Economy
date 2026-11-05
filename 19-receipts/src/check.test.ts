import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, type Fact } from "./facts.js";
import { checkAnswer } from "./check.js";

function facts(...values: string[]): Fact[] {
  const ledger = new Ledger();
  for (const value of values) ledger.add({ label: "x", value, unit: "USDC", block: 22136908, source: "chain" });
  return ledger.facts();
}

test("ledger hands out ids in order", () => {
  const ledger = new Ledger();
  assert.equal(ledger.add({ label: "a", value: "1", unit: "T", block: 1, source: "chain" }).id, "F1");
  assert.equal(ledger.add({ label: "b", value: "2", unit: "T", block: 1, source: "chain" }).id, "F2");
});

test("a cited number that matches passes", () => {
  assert.deepEqual(checkAnswer("You hold 12.5 pDOG [F1]", facts("12.5")), { ok: true, problems: [] });
});

test("a cited number that doesn't match is caught", () => {
  const r = checkAnswer("You hold 14 pDOG [F1]", facts("12.5"));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /14 .*F1.*12\.5/);
});

test("a number with no fact id is caught", () => {
  const r = checkAnswer("You hold 12.5 pDOG", facts("12.5"));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /12\.5 has no fact id/);
});

test("a sum of cited facts passes", () => {
  assert.equal(checkAnswer("In total 30 USDC [F1, F2]", facts("10", "20")).ok, true);
});

test("a percent change between two cited facts passes", () => {
  assert.equal(checkAnswer("pTACO is up 25% since you bought it [F1, F2]", facts("0.08", "0.1")).ok, true);
});

test("rounding to what was shown is fine", () => {
  assert.equal(checkAnswer("about 1,355.40 PROS [F1]", facts("1355.3972602")).ok, true);
  assert.equal(checkAnswer("about 1,356 PROS [F1]", facts("1355.3972602")).ok, true);
});

test("block numbers, addresses, ids and list markers are not figures", () => {
  const text = [
    "1. Read at block 22136908 from 0x52acdeb49056518578c7af788ae2c367132e2db5 [F1]",
    "2) tx 0x477abd8f7c73409e5dd831e77941009618dceb4c724377c1ae188b64cce7dbf5 on 2026-11-04",
  ].join("\n");
  assert.equal(checkAnswer(text, facts("7")).ok, true);
});

test("citing a fact that doesn't exist is caught", () => {
  const r = checkAnswer("You hold 7 pDOG [F9]", facts("7"));
  assert.equal(r.ok, false);
  assert.match(r.problems[0], /F9 does not exist/);
});
