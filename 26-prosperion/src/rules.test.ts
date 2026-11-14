import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address } from "viem";
import {
  launchAlert, snipePlan, progressEvents, whaleAlert, positionMoves, gateAlert, decodeGateLog, digestText,
  LIMITS_SET_TOPIC, BOUGHT_TOPIC, type BoardSnap,
} from "./rules.js";
import { DEFAULT_SUBS } from "./subscriptions.js";
import type { Launch } from "./store.js";

const ME = "0x59F74eD82A08F80cff5D7E8055f6a24A18595F64" as Address;
const MARKET = "0xBB3DC336E9221be62cc63e62E3969580B5BAB82c" as Address;
const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672" as Address;
const launch = (reserve: bigint, over: Partial<Launch> = {}): Launch => ({
  market: MARKET, vault: "0xc35d8e066ba00a1d433f08500eb1b6032d8cbf47", pToken: "0x05457dA2c193ce92C1877ec2B9eA3966bD54fafE",
  block: 100n, tx: "0xabc",
  checks: { market: MARKET, block: 101n, genuine: true, vault: null, pToken: null, phase: 0, reserveBefore: reserve, implNow: IMPL, amountIn: 0n, quoteOut: 0n },
  ...over,
});

test("a launch alert respects how much may already be in the curve and the curators you skip", () => {
  const p = { ...DEFAULT_SUBS.launch, on: true, maxInCurvePros: "0" };
  assert.ok(launchAlert(launch(0n), p, null));
  assert.equal(launchAlert(launch(1n), p, null), null, "someone is already in");
  assert.ok(launchAlert(launch(parseEther("5")), { ...p, maxInCurvePros: null }, null), "empty means any");
  assert.equal(launchAlert(launch(0n), { ...p, skipCurators: ["0xfaeccf5a7cde65fe358e9547cc80046f6dbc2c1a"] }, "0xFAECCF5a7cde65fe358e9547cc80046f6dbc2c1a"), null);
  const fake = launch(0n);
  fake.checks!.genuine = false;
  assert.equal(launchAlert(fake, { ...p, maxInCurvePros: null }, null), null, "never alert on a market the factory does not list");
  const a = launchAlert(launch(0n), p, null)!;
  assert.equal(a.key, `launch:${MARKET}`);
  assert.match(a.text, /New Prosper launch/);
  assert.ok(a.buttons!.flat().some((b) => b.data === `follow:${MARKET}`));
});

test("a snipe is prepared only inside your own gate limits; without any, the page will offer them first", () => {
  const p = { ...DEFAULT_SUBS.snipe, on: true, amountPros: "0.5", maxInCurvePros: "0" };
  const have = { maxPerBuy: parseEther("1"), maxPerDay: parseEther("3"), maxReserveBefore: 0n, acceptedMarketImpl: IMPL };
  assert.deepEqual(snipePlan(launch(0n), p, { have, spent: 0n }), { ok: true, amountWei: parseEther("0.5"), maxReserveWei: 0n });
  assert.deepEqual(snipePlan(launch(0n), p, { have: null, spent: 0n }), { ok: true, amountWei: parseEther("0.5"), maxReserveWei: 0n });
  const over = snipePlan(launch(0n), { ...p, amountPros: "2" }, { have, spent: 0n });
  assert.equal(over?.ok, false);
  if (over && !over.ok) assert.match(over.reason, /above your limit of 1 PROS per buy/);
  assert.equal(snipePlan(launch(parseEther("1")), p, { have, spent: 0n }), null, "already taken: no snipe, no message");
});

test("progress fires once per threshold crossed and on a phase change, never on the first look", () => {
  const before: BoardSnap = { [MARKET]: { symbol: "pANTA", phase: 0, bps: 4_900 } };
  assert.deepEqual(progressEvents(undefined, before, [50]), [], "first look is a baseline");
  const after: BoardSnap = { [MARKET]: { symbol: "pANTA", phase: 0, bps: 7_600 } };
  assert.deepEqual(progressEvents(before, after, [50, 75, 90]).map((e) => e.key), [`progress:${MARKET}:50`, `progress:${MARKET}:75`]);
  const grad: BoardSnap = { [MARKET]: { symbol: "pANTA", phase: 2, bps: 0 } };
  const e = progressEvents(after, grad, [90]);
  assert.deepEqual(e.map((x) => x.key), [`phase:${MARKET}:2`]);
  assert.match(e[0].text, /pANTA graduated/);
  assert.deepEqual(progressEvents(after, { ...after, "0x0000000000000000000000000000000000000001": { symbol: "pNEW", phase: 0, bps: 9_500 } }, [90]), [], "a market seen for the first time is a baseline too");
});

test("a whale trade is sized on the PROS that moved, and keyed by its log so two sources do not double it", () => {
  const t = { market: MARKET, block: 5n, tx: "0xdead" as const, logIndex: 3, kind: "sell" as const, trader: ME, caller: ME,
    prosGross: parseEther("600"), prosNet: parseEther("594"), tokens: 10n ** 24n, fee: parseEther("6") };
  assert.equal(whaleAlert(t, parseEther("700"), "pANTA"), null);
  const a = whaleAlert(t, parseEther("500"), "pANTA")!;
  assert.equal(a.key, "trade:0xdead:3");
  assert.match(a.text, /sold .*600 PROS/);
});

test("positions alert on a move per unit since the last alert; a changed balance resets quietly", () => {
  const h = (balance: bigint, sell: bigint) => ({ token: "0x05457dA2c193ce92C1877ec2B9eA3966bD54fafE" as Address, symbol: "pANTA", kind: "pToken" as const, balance, value: sell });
  const first = positionMoves({}, [h(100n, 1000n)], 10, 1);
  assert.deepEqual(first.alerts, []);
  const small = positionMoves(first.base, [h(100n, 1050n)], 10, 1);
  assert.deepEqual(small.alerts, []);
  assert.equal(small.base[h(0n, 0n).token].value, "1000", "the baseline stays at the last alert, so slow drifts add up");
  const big = positionMoves(small.base, [h(100n, 1120n)], 10, 1);
  assert.equal(big.alerts.length, 1);
  assert.match(big.alerts[0].text, /pANTA .*up 12%/);
  const bought = positionMoves(big.base, [h(200n, 2600n)], 10, 1);
  assert.deepEqual(bought.alerts, [], "you bought more: not a price move");
});

test("the gate's own events about your wallet read as plain words", () => {
  const limitsLog = {
    topics: [LIMITS_SET_TOPIC, `0x000000000000000000000000${ME.slice(2).toLowerCase()}`],
    data: `0x${[parseEther("10"), parseEther("30"), parseEther("11415"), BigInt(IMPL)].map((x) => x.toString(16).padStart(64, "0")).join("")}`,
    transactionHash: "0x20a0", logIndex: "0x1", blockNumber: "0x15e8d44",
  };
  const d = decodeGateLog(limitsLog)!;
  assert.equal(d.user, ME);
  const a = gateAlert(d);
  assert.match(a.text, /limits changed/i);
  assert.match(a.text, /10 PROS per buy, 30 PROS a day/);
  assert.match(a.text, /not you/i);
  const boughtLog = {
    topics: [BOUGHT_TOPIC, `0x000000000000000000000000${ME.slice(2).toLowerCase()}`, `0x000000000000000000000000${MARKET.slice(2).toLowerCase()}`],
    data: `0x${[parseEther("10"), 123n * 10n ** 18n].map((x) => x.toString(16).padStart(64, "0")).join("")}`,
    transactionHash: "0x3d23", logIndex: "0x2", blockNumber: "0x15e8d4e",
  };
  assert.match(gateAlert(decodeGateLog(boughtLog)!).text, /bought .*10 PROS/i);
});

test("the digest lists what you hold and the launches closest to graduating", () => {
  const t = digestText("2026-11-14", [{ symbol: "pANTA", kind: "pToken", text: "204,641 tokens, a full sell pays 9.8 PROS" }], [
    { symbol: "pANTA", bps: 5_712, hoursLeft: 133.2 },
  ]);
  assert.match(t, /2026-11-14/);
  assert.match(t, /pANTA.*204,641/);
  assert.match(t, /57\.1%/);
  assert.match(digestText("2026-11-14", [], []), /nothing in Prosper/i);
});
