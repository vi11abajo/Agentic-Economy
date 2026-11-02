import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { change, computeMetrics } from "./metrics.js";
import type { Market, Trade } from "./prosper.js";

const t = (side: "BUY" | "SELL", trader: string, pros: number, price: number, block: number, market = "m1"): Trade => ({
  id: `${block}:${trader}`, market, symbol: market.toUpperCase(), side, trader, pros, tokens: pros / price, fee: pros / 100, price, block, time: block, tx: `0x${block}`,
});
const mk = (market: string, createdBlock: number): Market => ({ market, pToken: market, symbol: market.toUpperCase(), decimals: 18, createdBlock });

describe("metrics", () => {
  const trades = [t("BUY", "a", 10, 1, 100), t("BUY", "b", 5, 2, 110), t("BUY", "a", 3, 3, 120), t("SELL", "c", 4, 2.5, 130)];
  const { metrics, tokens } = computeMetrics({
    trades,
    created: [mk("m2", 105)],
    traders: { a: 100, b: 50, c: 130 },
    startBlock: 100,
    endBlock: 199,
    phases: { m1: { start: 0, end: 2 }, m2: { start: null, end: 0 }, m3: { start: 2, end: 2 }, m4: { start: 0, end: 0 } },
  });

  it("sums volume, flow, trades, traders and fees", () => {
    assert.equal(metrics.buys, 18);
    assert.equal(metrics.sells, 4);
    assert.equal(metrics.volume, 22);
    assert.equal(metrics.netFlow, 14);
    assert.equal(metrics.trades, 4);
    assert.equal(metrics.traders, 3);
    assert.equal(metrics.newTraders, 2, "a and c traded first in the period, b before it");
    assert.equal(metrics.fees.toFixed(6), "0.220000");
    assert.equal(metrics.newMarkets, 1);
  });

  it("counts a graduation only for a market that left the curve in the period", () => {
    assert.equal(metrics.graduated, 1);
    assert.equal(metrics.onCurve, 2);
  });

  it("gives per-token volume and first-to-last price change", () => {
    assert.equal(tokens[0].market, "m1");
    assert.equal(tokens[0].volume, 22);
    assert.equal(tokens[0].changePct, 150);
    assert.equal(tokens[0].phaseEnd, 2);
  });

  it("a quiet period is all zeros, never NaN", () => {
    const q = computeMetrics({ trades: [], created: [], traders: {}, startBlock: 1, endBlock: 2, phases: {} });
    assert.ok(Object.values(q.metrics).every((v) => v === 0));
    assert.deepEqual(q.tokens, []);
  });

  it("change is null without a usable previous value", () => {
    assert.equal(change(0, 0), null);
    assert.equal(change(5, undefined), null);
    assert.equal(Math.round(change(48210, 39195)!), 23);
    assert.equal(change(5, 10), -50);
  });
});
