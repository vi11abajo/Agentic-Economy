import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { trends } from "./trends.js";
import type { Digest, Metrics } from "./types.js";

const m = (volume: number, trades = 10, traders = 5, netFlow = 1): Metrics => ({ volume, buys: volume, sells: 0, netFlow, trades, traders, newTraders: 0, fees: 0, newMarkets: 0, graduated: 0, onCurve: 0 });
const d = (metrics: Metrics, days = 7) => ({ days, metrics }) as Digest;

describe("trends", () => {
  it("needs at least 3 earlier periods", () => {
    assert.deepEqual(trends([d(m(1)), d(m(2))], m(3)), []);
  });

  it("reports a growth streak", () => {
    const t = trends([d(m(1)), d(m(2)), d(m(3))], m(4));
    assert.ok(t.includes("Volume up for the 3rd week in a row"), t.join("|"));
  });

  it("compares with the 4-period average", () => {
    const t = trends([d(m(10, 10)), d(m(10, 10)), d(m(10, 10)), d(m(10, 10))], m(10, 14));
    assert.ok(t.includes("Trades 40% above the 4-week average"), t.join("|"));
  });

  it("says period instead of week for other lengths and skips other lengths' history", () => {
    const t = trends([d(m(1), 3), d(m(2), 3), d(m(3), 3), d(m(9), 7)], m(4), 3);
    assert.ok(t.includes("Volume up for the 3rd period in a row"), t.join("|"));
  });
});
