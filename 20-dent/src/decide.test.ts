import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEven, compareRates, decide, netOfMove, windowRates, type Place } from "./decide.js";

const place = (p: Partial<Place> & { id: string }): Place => ({ name: p.id, status: "open", entryFee: 0, exitFee: 0, waitSeconds: 0, ...p });

test("rates are compared window by window, and the window worst for the move counts", () => {
  const from = place({ id: "a", rateNow: 0.02, realized7d: 0.03, realized30d: 0.01 });
  const to = place({ id: "b", rateNow: 0.05, rateWithYou: 0.04, realized7d: 0.035, realized30d: 0.06 });
  // now: 0.04 vs 0.02 (+2%), 7d: 0.035 vs 0.03 (+0.5%), 30d: min(0.06, 0.04) vs 0.01 (+3%) -> 7 days counts
  assert.deepEqual(compareRates(from, to), { rFrom: 0.03, rTo: 0.035, how: "over the last 7 days" });
  // the wallet earns 0 in every window
  assert.deepEqual(windowRates(place({ id: "w", fixedRate: 0 }), false), { now: 0, "7d": 0, "30d": 0 });
  assert.equal(compareRates(place({ id: "x" }), place({ id: "y", rateNow: 0.1 })), undefined);
});

test("two places riding the same underlying rate: dropping a 0% layer is a gain, not a loss", () => {
  // A Faroo vault holds stPROS: in PROS it earns stPROS's rate plus its own 0%. stPROS alone earns the same.
  const vault = place({ id: "vault", realized7d: 0.31, realized30d: 0.0867 });
  const st = place({ id: "st", realized7d: 0.31, realized30d: 0.0867 });
  const c = compareRates(vault, st)!;
  assert.equal(c.rTo - c.rFrom, 0);
});

test("net of a move: fees off the principal, gas once, nothing earned while unbonding", () => {
  const m = netOfMove(1000, 0, 0.0365, 0, 0, 0, 1, 100);
  assert.ok(Math.abs(m.net - 9) < 1e-9); // 1000 * 3.65% * 100/365 = 10, minus 1 gas
  const waiting = netOfMove(1000, 0, 0.0365, 0, 0, 10, 1, 100);
  assert.equal(waiting.earning, 90);
  assert.ok(Math.abs(waiting.net - 8) < 1e-9);
  const fee = netOfMove(1000, 0, 0, 0.01, 0, 0, 0, 30);
  assert.ok(Math.abs(fee.net + 10) < 1e-9);
});

test("break-even days, and never when the new place doesn't pay more", () => {
  assert.equal(breakEven(1000, 0, 0.0365, 0, 0, 0, 1), 10); // earns 0.1/day, gas 1
  assert.equal(breakEven(1000, 0.05, 0.04, 0, 0, 0, 1), null);
  assert.equal(breakEven(1000, 0, 0.0365, 0, 0, 0, 0), 0);
});

test("MOVE when the best option pays back inside the hold and clears the minimum", () => {
  const d = decide({
    from: place({ id: "wallet", fixedRate: 0 }),
    amount: 1000,
    places: [place({ id: "wallet", rateNow: 0 }), place({ id: "good", rateWithYou: 0.0365 }), place({ id: "better-but-closed", status: "closed", why: "InvalidPhase(3)" })],
    costs: { good: { gas: 1 } },
    holdDays: 30,
    minGain: 0.5,
  });
  assert.equal(d.action, "MOVE");
  assert.equal(d.to, "good");
  assert.match(d.options.find((o) => o.id === "better-but-closed")!.why, /closed: InvalidPhase\(3\)/);
});

test("STAY PUT when gas eats the gain inside the hold, with that as the reason", () => {
  const d = decide({
    from: place({ id: "wallet", fixedRate: 0 }),
    amount: 0.5,
    places: [place({ id: "pool", rateWithYou: 0.0193 })],
    costs: { pool: { gas: 0.002 } },
    holdDays: 30,
    minGain: 0.01,
  });
  assert.equal(d.action, "STAY PUT");
  assert.match(d.reason, /pays back only after \d+ days, longer than your 30-day hold/);
});

test("STAY PUT when the current pool can't pay you out", () => {
  const d = decide({
    from: place({ id: "pool", rateNow: 0.01, exitRoom: 50 }),
    amount: 100,
    places: [place({ id: "other", rateWithYou: 0.2 })],
    costs: { other: { gas: 0 } },
    holdDays: 30,
    minGain: 0,
  });
  assert.equal(d.action, "STAY PUT");
  assert.match(d.reason, /only 50 free to withdraw/);
});

test("a destination whose rate collapses under your deposit loses", () => {
  const d = decide({
    from: place({ id: "a", rateNow: 0.019 }),
    amount: 100,
    places: [place({ id: "tiny", rateNow: 0.0183, rateWithYou: 0.00028 })],
    costs: { tiny: { gas: 0.002 } },
    holdDays: 365,
    minGain: 0,
  });
  assert.equal(d.action, "STAY PUT");
  assert.match(d.options[0].why, /not more than/);
});

test("supply cap and unknown gas are reasons, not zeros", () => {
  const d = decide({
    from: place({ id: "a", rateNow: 0 }),
    amount: 100,
    places: [place({ id: "capped", rateWithYou: 0.5, entryRoom: 10 }), place({ id: "nogas", rateWithYou: 0.5 })],
    costs: { nogas: { gasWhy: "Aave error code 51" } },
    holdDays: 30,
    minGain: 0,
  });
  assert.equal(d.action, "STAY PUT");
  assert.match(d.options.find((o) => o.id === "capped")!.why, /supply cap/);
  assert.match(d.options.find((o) => o.id === "nogas")!.why, /gas unknown: Aave error code 51/);
});

test("a source whose exit reverts is STAY PUT with the revert as the reason", () => {
  const d = decide({
    from: place({ id: "vault", rateNow: 0, exitBlocked: "redeem reverts: InvalidPhase(1)" }),
    amount: 2,
    places: [place({ id: "st", rateNow: 0.08 })],
    costs: { st: { gas: 0 } },
    holdDays: 30,
    minGain: 0,
  });
  assert.equal(d.action, "STAY PUT");
  assert.match(d.reason, /InvalidPhase\(1\)/);
});
