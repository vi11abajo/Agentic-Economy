// The send-or-not decision, as plain functions, pinned by the final review's findings.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import type { Step } from "./batch.js";
import { MULTICALL3, WPROS } from "./book.js";
import { gatekeep, multicallKeeps } from "./verdict.js";

const rb = (asset: `0x${string}` | "PROS", symbol: string): Step => ({ action: -1, label: "", reads: { holder: MULTICALL3, asset, symbol, decimals: 18 }, call: { target: MULTICALL3, allowFailure: true, value: 0n, callData: "0x" } });
const key = (asset: string) => `${MULTICALL3}|${asset}`.toLowerCase();
const base = { results: [], wholeRevert: false, keeps: [], gas: 100_000n, price: 10n, pros: 10n ** 20n, value: 0n, usesUsdc: false, usdc: 0n, usdcNeeded: 0n, shortfalls: [], contractRecipients: [] };

describe("multicallKeeps", () => {
  it("counts only what the batch itself leaves behind, not dust someone parked there before", () => {
    const before = new Map([[key("PROS"), 1n]]);
    const after = new Map([[key("PROS"), 1n]]);
    assert.deepEqual(multicallKeeps([rb("PROS", "PROS")], before, after), []);
  });

  it("flags anything the batch adds to Multicall3", () => {
    const before = new Map([[key(WPROS), 0n]]);
    const after = new Map([[key(WPROS), 10n ** 18n]]);
    assert.deepEqual(multicallKeeps([rb(WPROS, "WPROS")], before, after), [{ symbol: "WPROS", amount: 10n ** 18n }]);
  });
});

describe("gatekeep", () => {
  it("won't send without a gas number", () => {
    assert.ok(gatekeep({ ...base, gas: null }).some((r) => /gas/.test(r)));
  });

  it("won't send when a buy would deliver less than quoted", () => {
    const r = gatekeep({ ...base, shortfalls: [{ symbol: "pFAKE", got: 0n, promised: 5n }] });
    assert.ok(r.some((x) => /pFAKE/.test(x) && /less/.test(x)));
  });

  it("won't send PROS to a contract, which might credit Multicall3 instead of anyone", () => {
    const r = gatekeep({ ...base, contractRecipients: [getAddress(WPROS)] });
    assert.ok(r.some((x) => x.includes(getAddress(WPROS)) && /contract/.test(x)));
  });

  it("is happy with a clean batch", () => {
    assert.deepEqual(gatekeep(base), []);
  });
});
