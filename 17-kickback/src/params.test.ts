import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CAPS, DEFAULTS, amountRaw, checkParams } from "./params.js";

test("the defaults pass the default caps", () => {
  assert.deepEqual(checkParams(DEFAULTS, DEFAULT_CAPS), []);
  assert.deepEqual(DEFAULTS, { pool: 30, winners: 3, amount: "0.00001", token: "USDC", delay: 5 });
});

test("as many winners as people is refused", () => {
  const problems = checkParams({ ...DEFAULTS, winners: 30, pool: 30 }, DEFAULT_CAPS);
  assert.ok(problems.some((p) => p.includes("fewer winners than people")));
});

test("a pool over 100 is refused", () => {
  assert.equal(checkParams({ ...DEFAULTS, pool: 101 }, DEFAULT_CAPS).length, 1);
});

test("a delay outside 1..50 is refused", () => {
  assert.equal(checkParams({ ...DEFAULTS, delay: 0 }, DEFAULT_CAPS).length, 1);
  assert.equal(checkParams({ ...DEFAULTS, delay: 51 }, DEFAULT_CAPS).length, 1);
});

test("an amount below one USDC unit is refused", () => {
  const problems = checkParams({ ...DEFAULTS, amount: "0.0000001" }, DEFAULT_CAPS);
  assert.ok(problems.some((p) => p.includes("below the smallest USDC unit")));
});

test("garbage amounts are refused, not crashed on", () => {
  assert.equal(checkParams({ ...DEFAULTS, amount: "lots" }, DEFAULT_CAPS).length, 1);
  assert.equal(checkParams({ ...DEFAULTS, amount: "-1" }, DEFAULT_CAPS).length, 1);
});

test("going over the USDC cap names the cap", () => {
  const problems = checkParams({ ...DEFAULTS, winners: 3, amount: "0.0001" }, DEFAULT_CAPS);
  assert.ok(problems.some((p) => p.includes("max_total_usdc") && p.includes("0.0001")));
});

test("going over the PROS cap names the cap", () => {
  const problems = checkParams({ ...DEFAULTS, token: "PROS", amount: "0.001" }, DEFAULT_CAPS);
  assert.ok(problems.some((p) => p.includes("max_total_pros")));
});

test("amountRaw uses 6 decimals for USDC and 18 for PROS", () => {
  assert.equal(amountRaw(DEFAULTS), 10n);
  assert.equal(amountRaw({ ...DEFAULTS, token: "PROS", amount: "0.0001" }), 100000000000000n);
});
