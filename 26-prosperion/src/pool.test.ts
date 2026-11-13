import { test } from "node:test";
import assert from "node:assert/strict";
import { poolFrom, WPROS } from "./pool.js";

const PDOG = "0xcBe766992CA01E8B927CF092Afe806f2D61AFaD7";

// pDOG's FaroSwap pair 0x0A43…584F, read 2026-11-13: token0 WPROS 17,389.2776 / token1 pDOG 248,194,915.27
test("a graduated pToken's price is the PROS side of its pair over the token side, whichever order they sit in", () => {
  const p = poolFrom(WPROS, PDOG, 17_389_277_600_737_640_918_760n, 248_194_915_269_823_092_806_332_925n, PDOG);
  assert.equal(p.prosInPool, "17389.27760073764091876");
  assert.equal(p.tokensInPool, "248194915.269823092806332925");
  assert.equal(p.prosPerMillionTokens, "70.0629");
  const flipped = poolFrom(PDOG, WPROS, 248_194_915_269_823_092_806_332_925n, 17_389_277_600_737_640_918_760n, PDOG);
  assert.deepEqual(flipped, p);
});

test("a pair without WPROS on one side is said to be so, not priced", () => {
  assert.throws(() => poolFrom("0x0000000000000000000000000000000000000001", PDOG, 1n, 1n, PDOG), /not paired with WPROS/);
});
