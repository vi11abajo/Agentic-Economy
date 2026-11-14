import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { profileFrom, rankBoard, type BoardEntry } from "./board.js";

const e = (symbol: string, phase: number, pros: number, endsAt: number): BoardEntry => ({
  symbol, token: symbol, vaultName: symbol, market: `0x${symbol.padStart(40, "0")}` as Address, pToken: "0x0000000000000000000000000000000000000001",
  vault: "0x0000000000000000000000000000000000000002", phase, phaseName: "", prosInCurve: BigInt(pros) * 10n ** 18n,
  target: 20_000n * 10n ** 18n, progressBps: pros / 2, endsAt, hoursLeft: 0,
});
// numbers as they stood at block 22,969,525: pANTA 11,415 PROS, pBOT 7,149, pFROG 18.9, pOnio empty
const live = [e("FROG", 0, 19, 300), e("DOG", 2, 0, 50), e("ANTA", 0, 11_415, 130), e("Pika", 3, 0, 40), e("BOT", 0, 7_149, 255), e("Onio", 0, 0, 152), e("Cats", 0, 0, 100)];

test("open markets come first and closest to graduating first; two empty ones, the one that closes sooner", () => {
  assert.deepEqual(rankBoard(live, "curve", 10).map((x) => x.symbol), ["ANTA", "BOT", "FROG", "Cats", "Onio"]);
});

test("the board can show graduated or failed ones, and all of them, and cuts at the limit", () => {
  assert.deepEqual(rankBoard(live, "graduated", 10).map((x) => x.symbol), ["DOG"]);
  assert.deepEqual(rankBoard(live, "failed", 10).map((x) => x.symbol), ["Pika"]);
  assert.equal(rankBoard(live, "all", 10).length, 7);
  assert.deepEqual(rankBoard(live, "all", 2).map((x) => x.symbol), ["ANTA", "BOT"]);
});

test("a vault profile keeps Prosper's words apart from what was read on chain", () => {
  const p = profileFrom({
    vaultName: "Barker Neutral Carry", r25Vault: "0x3ed49843a55952a399db99c8949f67a9d821611c", share: "0x2D3f6CbB1662B87f2ea998a58c194Ff20e1C9a68",
    r25Display: { curator: { name: null, address: "0xd29648521ab2d79b508a6194e9b73f5d44d49452" }, managementFeeRateBps: 50, performanceFeeRateBps: 2000, currentNav: "1.079797", strategyDescription: "delta-neutral" },
  }, { block: 22_969_700n, navPerShareUsdc: 1_079_797n });
  assert.equal(p.vault, "0x3Ed49843a55952A399dB99C8949f67a9D821611C");
  assert.equal(p.fromProsperApi.curator, "0xd29648521ab2d79b508a6194e9b73f5d44d49452");
  assert.equal(p.fromProsperApi.managementFee, "0.5%");
  assert.equal(p.fromProsperApi.performanceFee, "20%");
  assert.match(p.fromProsperApi.note, /not read on chain/);
  assert.equal(p.onChain.navPerShareUsdc, 1_079_797n);
  assert.equal(p.fromProsperApi.depositFee, null, "a fee the API did not send stays unknown, not zero");
});
