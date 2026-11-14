// Real vaults, real blocks. Barker Neutral Carry is the big one (mostly USDC sitting in escrow on Pharos),
// EM Lockhart Edge is nearly all a number the operator reports from Hyperliquid.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readVault } from "./vault.js";
import { explainNavMove } from "./navmove.js";

const BARKER = "0x3ed49843a55952a399db99c8949f67a9d821611c";
const LOCKHART = "0xac290ddd46376ba3b80c699698af4b379288c27a";
const BEFORE_BURN = 22652603n;

test("Barker before the burn: 89% sits on Pharos and the parts add up to the oracle's NAV", async () => {
  const v = await readVault(BARKER, BEFORE_BURN);
  assert.equal(v.block, BEFORE_BURN);
  assert.equal(v.totalAssets, 112_322_158_965n);
  assert.equal(v.reconciles, true);
  assert.ok(v.verifiableBps >= 8800 && v.verifiableBps <= 9000, `verifiable ${v.verifiableBps}`);
  assert.equal(v.adapters.filter((a: any) => a.kind === "Mirror").length, 1);
  assert.ok(v.escrow.some((e: any) => e.asset.toLowerCase() === "0xc879c018db60520f4355c26ed1a6d572cdac1815" && e.amount > 0n));
  assert.ok(v.prices.every((p: any) => p.stale), "the oracle was hours old, every price should be stale");
});

test("Lockhart today: almost nothing can be checked on Pharos", async () => {
  const v = await readVault(LOCKHART);
  assert.equal(v.reconciles, true);
  assert.ok(v.verifiableBps < 100, `verifiable ${v.verifiableBps}`);
});

test("Barker's jump on Nov 10 was an admin burn of 593.83 shares, not trading", async () => {
  const m = await explainNavMove(BARKER, BEFORE_BURN, BEFORE_BURN + 1n);
  assert.equal(m.assetsDelta, 0n);
  const admin = m.parts.find((p) => p.kind === "admin");
  assert.ok(admin, "no admin part");
  assert.equal(admin.unit, "shares");
  assert.ok(admin.delta < 0n && admin.delta > -593_840_000_000_000_000_000n && admin.delta < -593_820_000_000_000_000_000n, `${admin.delta}`);
  assert.equal(admin.txs.length, 1);
  assert.ok(m.navTo > m.navFrom);
  assert.ok(!m.parts.some((p) => p.kind === "flows"));
});
