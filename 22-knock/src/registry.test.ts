import { test } from "node:test";
import assert from "node:assert/strict";
import { findBySymbol, REGISTRY } from "./registry.js";

test("USDC is the Circle contract the docs list", () => {
  assert.equal(findBySymbol("usdc")?.address, "0xc879c018db60520f4355c26ed1a6d572cdac1815");
  assert.equal(findBySymbol("USDC")?.decimals, 6);
});

test("USDT is not on the mainnet list, so knock doesn't pretend it is", () => {
  assert.equal(findBySymbol("USDT"), undefined);
});

test("PROS is the native coin, under any of its spellings", () => {
  assert.equal(findBySymbol("pros")?.address, "native");
  assert.equal(findBySymbol("PHRS")?.address, "native");
});

test("five tokens, all with a source", () => {
  assert.equal(REGISTRY.length, 5);
  for (const t of REGISTRY) assert.ok(t.source.length > 0);
});
