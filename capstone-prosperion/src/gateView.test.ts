import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address } from "viem";
import { gateLimitsView } from "./gateView.js";

const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672" as Address;
const OTHER = "0x0000000000000000000000000000000000000001" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const base = { block: 23_024_200n, implNow: IMPL, dayEndsAt: 1_794_700_800 };

test("set limits read back in PROS, with what is left for today and the block", () => {
  const v = gateLimitsView({
    ...base, spent: parseEther("0.1"),
    limits: { maxPerBuy: parseEther("1"), maxPerDay: parseEther("30"), maxReserveBefore: parseEther("20000"), acceptedMarketImpl: IMPL },
  });
  assert.equal(v.state, "active");
  assert.equal(v.block, 23_024_200n);
  assert.equal(v.perBuyPros, "1");
  assert.equal(v.perDayPros, "30");
  assert.equal(v.spentTodayPros, "0.1");
  assert.equal(v.leftTodayPros, "29.9");
  assert.equal(v.maxInCurvePros, "20000");
  assert.equal(v.marketCodeAccepted, true);
  assert.match(v.changeAt, /\/launches\/#limits$/);
});

test("never set, stopped and an upgraded market code each say so in words", () => {
  const never = gateLimitsView({ ...base, spent: 0n, limits: null });
  assert.equal(never.state, "not set");
  assert.match(never.note, /setLimits/);

  const stopped = gateLimitsView({ ...base, spent: 0n, limits: { maxPerBuy: 0n, maxPerDay: 0n, maxReserveBefore: 0n, acceptedMarketImpl: IMPL } });
  assert.equal(stopped.state, "stopped");
  assert.match(stopped.note, /every buy through the gate reverts/i);

  const moved = gateLimitsView({ ...base, spent: 0n, limits: { maxPerBuy: 1n, maxPerDay: 1n, maxReserveBefore: 1n, acceptedMarketImpl: OTHER } });
  assert.equal(moved.marketCodeAccepted, false);
  assert.match(moved.note, /upgraded/);

  const spentOver = gateLimitsView({ ...base, spent: parseEther("5"), limits: { maxPerBuy: parseEther("1"), maxPerDay: parseEther("2"), maxReserveBefore: 0n, acceptedMarketImpl: IMPL } });
  assert.equal(spentOver.leftTodayPros, "0", "never a negative allowance");
  assert.notEqual(ZERO, IMPL);
});
