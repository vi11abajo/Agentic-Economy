import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDecimal } from "./ledger.js";
import { formatAmount } from "./report.js";
import { lastBlockAtOrBefore, localTime, readPeriod } from "./period.js";

test("bare dates cover whole days in the user's zone, both ends included", () => {
  const p = readPeriod("2026-11-01", "2026-11-10", "+03:00");
  assert.equal(p.from, Date.UTC(2026, 9, 31, 21, 0, 0) / 1000);
  assert.equal(p.to, Date.UTC(2026, 10, 10, 20, 59, 59) / 1000);
  assert.equal(localTime(p.from, p.zone), "2026-11-01 00:00");
  assert.equal(localTime(p.to, p.zone, true), "2026-11-10 23:59:59");
});

test("times without a zone are read in the given zone, and nonsense is refused", () => {
  const p = readPeriod("2026-11-01T09:30", "2026-11-01T18:00", "UTC");
  assert.equal(p.from, Date.UTC(2026, 10, 1, 9, 30) / 1000);
  assert.throws(() => readPeriod("2026-11-10", "2026-11-01"), /ends .* before it starts/);
  assert.throws(() => readPeriod("2026-11-01", "2026-11-02", "Moscow"), /time zone/);
});

test("the block search finds the last block at or before a moment", async () => {
  const times = [0, 10, 10, 13, 20, 31, 40];
  const timeOf = async (n: bigint) => times[Number(n)];
  assert.equal(await lastBlockAtOrBefore(12, 6n, timeOf), 2n);
  assert.equal(await lastBlockAtOrBefore(13, 6n, timeOf), 3n);
  assert.equal(await lastBlockAtOrBefore(99, 6n, timeOf), 6n);
  assert.equal(await lastBlockAtOrBefore(30, 6n, timeOf), 4n);
});

test("amounts are exact both ways: explorer decimals in, every unit out", () => {
  assert.equal(parseDecimal("0.00044942", 18), 449_420_000_000_000n);
  assert.equal(parseDecimal("2", 6), 2_000_000n);
  assert.equal(parseDecimal("1.5e-7", 18), 150_000_000_000n);
  assert.equal(formatAmount(1_385_676_143_983_257_730_873n * 1000n, 21), "1,385.676143983257730873");
  assert.equal(formatAmount(-250_000n, 6), "-0.25");
  assert.equal(formatAmount(0n, 6), "0");
});
