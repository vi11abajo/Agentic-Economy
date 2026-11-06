import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THRESHOLDS as T, carryClock, checkThresholds, dropToLiquidation, levelOf, movesToTarget, nextLevel, priceShape,
  type Leg, type Snapshot,
} from "./health.js";
import { aimFor } from "./look.js";

const leg = (o: Partial<Leg>): Leg => ({
  token: "0x0000000000000000000000000000000000000001", symbol: "X", decimals: 6, amount: 1_000_000n, value: 1,
  lt: 0, apr: 0, priceShape: "moving", trendApr: 0, ...o,
});

// Shaped like the real syzUSD/USDC loop at block 22316216: HF 1.014, NAV oracle climbing 7.5%/yr, borrow 5.9%,
// 23.7% if suppliers leave.
const loop: Snapshot = {
  kind: "morpho", venue: "Morpho syzUSD/USDC", where: "0xc79579a002dbc8c535d3a87198fcbbece1a664ad82a356b0447c5bff9e16fd86",
  wallet: "0xA4A57DcF7B15456b7053f10A377Bdb437C073DCc", block: 1, time: 1, quote: "USDC", hf: 1.014,
  collateral: [leg({ token: "0x00000000000000000000000000000000000000c0", symbol: "syzUSD", decimals: 18, amount: 1_547_470n * 10n ** 18n, value: 1_692_660, lt: 0.915, priceShape: "climbing", trendApr: 0.0751 })],
  debt: [leg({ symbol: "USDC", amount: 1_527_385n * 10n ** 6n, value: 1_527_385, apr: 0.0591, stressApr: 0.237, priceShape: "flat" })],
};

test("levels follow the thresholds, 1.0 is the liquidation line", () => {
  assert.equal(levelOf(1.5, T), "ok");
  assert.equal(levelOf(1.3, T), "warn");
  assert.equal(levelOf(1.1, T), "critical");
  assert.equal(levelOf(1.0, T), "critical");
  assert.equal(levelOf(0.999, T), "liquidatable");
  assert.equal(levelOf(1.25, { ...T, warn: 1.2, critical: 1.05 }), "ok");
});

test("bad threshold orders are refused", () => {
  assert.equal(checkThresholds(T), null);
  assert.match(checkThresholds({ ...T, critical: 1.0 })!, /above 1.0/);
  assert.match(checkThresholds({ ...T, warn: 1.05 })!, /--warn/);
  assert.match(checkThresholds({ ...T, target: 1.2 })!, /--target/);
});

test("worse is instant, better needs the rearm gap", () => {
  assert.equal(nextLevel("ok", 1.29, T), "warn");
  assert.equal(nextLevel("warn", 1.31, T), "warn", "1.31 is inside the 0.02 rearm band");
  assert.equal(nextLevel("warn", 1.33, T), "ok");
  assert.equal(nextLevel("critical", 1.11, T), "critical");
  assert.equal(nextLevel("critical", 1.2, T), "warn");
  assert.equal(nextLevel(undefined, 1.05, T), "critical");
});

test("a NAV-priced loop has no price-drop number and a growing health", () => {
  assert.equal(dropToLiquidation(loop), null);
  const c = carryClock(loop);
  assert.equal(c.days, null);
  assert.ok(Math.abs(c.net - (0.0751 - 0.0591)) < 1e-9);
});

test("under stress the same loop runs out in about a month", () => {
  const c = carryClock(loop, true);
  // ln(1.014) / (0.237 - 0.0751) * 365
  assert.ok(c.days! > 30 && c.days! < 33, String(c.days));
});

test("price drop to liquidation for volatile collateral", () => {
  // 8.5 FBTC at $75,735, LT 0.70, debt $251,844 -> HF 1.789, falls 44% to hit 1
  const s: Snapshot = { ...loop, kind: "aave", quote: "USD", hf: 1.789,
    collateral: [leg({ token: "0x00000000000000000000000000000000000000fb", symbol: "FBTC", decimals: 8, amount: 850_000_000n, value: 643_751, lt: 0.7 })],
    debt: [leg({ symbol: "USDC", value: 251_844, amount: 251_844n * 10n ** 6n, apr: 0.03 })] };
  const d = dropToLiquidation(s)!;
  assert.ok(Math.abs(d - (1 - 1 / 1.7893)) < 0.001, String(d));
});

test("same token on both sides cancels, it isn't price risk", () => {
  const usdc = "0x00000000000000000000000000000000000000aa" as const;
  const s: Snapshot = { ...loop, kind: "aave", quote: "USD", hf: 1.04,
    collateral: [leg({ token: usdc, symbol: "USDC", value: 6.07, lt: 0.78 }), leg({ symbol: "WPROS", decimals: 18, amount: 10n ** 17n, value: 0.0547, lt: 0.78 })],
    debt: [leg({ token: usdc, symbol: "USDC", value: 4.594 })] };
  assert.equal(dropToLiquidation(s), 1, "WPROS going to zero still leaves HF above 1");
});

test("moves hit the target by the arithmetic", () => {
  const [repay, add] = movesToTarget(loop, 1.5);
  assert.equal(repay.kind, "repay");
  assert.equal(add.kind, "add");
  const carry = 1_692_660 * 0.915;
  const repaid = Number(repay.amount) / 1e6;
  assert.ok(carry / (1_527_385 - repaid) >= 1.5);
  assert.ok(carry / (1_527_385 - repaid + 2) < 1.5, "not more than a couple of units above what's needed");
  assert.ok(Math.abs(add.expectedHf - 1.5) < 1e-9);
});

test("nothing to do above the target", () => {
  assert.deepEqual(movesToTarget(loop, 1.0), []);
});

test("a short clock raises the aim so the fix buys time", () => {
  assert.equal(aimFor({ collateralGrowth: 0.05, debtGrowth: 0.03, net: 0.02, days: null }, 1.5, 30), 1.5);
  // net -2/yr: health 1.5 would last ln(1.5)/2 years = 74 days; for 60 days we need e^(2*60/365) = 1.389 -> target wins
  assert.equal(aimFor({ collateralGrowth: 0, debtGrowth: 2, net: -2, days: 1 }, 1.5, 30), 1.5);
  const hi = aimFor({ collateralGrowth: 0, debtGrowth: 5, net: -5, days: 1 }, 1.5, 30);
  assert.ok(Math.abs(hi - Math.exp((5 * 60) / 365)) < 1e-9);
});

test("price shapes: climbing, flat, moving", () => {
  const day = 86_400;
  assert.equal(priceShape([1, 1.001, 1.001, 1.002].map((p, i) => ({ time: i * day, price: p }))).shape, "climbing");
  assert.equal(priceShape([1, 1, 1].map((p, i) => ({ time: i * day, price: p }))).shape, "flat");
  assert.equal(priceShape([1, 1.1, 0.95].map((p, i) => ({ time: i * day, price: p }))).shape, "moving");
  const yr = priceShape([{ time: 0, price: 1 }, { time: 31_536_000, price: Math.E }]);
  assert.ok(Math.abs(yr.trendApr - 1) < 1e-12);
});
