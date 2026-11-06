import { test } from "node:test";
import assert from "node:assert/strict";
import { breakEven, decide, destinationRate, netOfMove, sourceRate, type Place } from "./decide.js";

const place = (p: Partial<Place> & { id: string }): Place => ({ name: p.id, status: "open", entryFee: 0, exitFee: 0, waitSeconds: 0, ...p });

test("where you are gets the best of its rates, where you'd go gets the worst", () => {
  assert.deepEqual(sourceRate(place({ id: "a", rateNow: 0.02, realized7d: 0.03, realized30d: 0.01 })), { rate: 0.03, how: "realised over 7 days" });
  // The rate with your money in it replaces the quoted rate; then the lowest wins.
  assert.deepEqual(destinationRate(place({ id: "b", rateNow: 0.05, rateWithYou: 0.01, realized7d: 0.04 })), { rate: 0.01, how: "with your deposit in it" });
  assert.equal(destinationRate(place({ id: "c" })), undefined);
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
    from: place({ id: "wallet", rateNow: 0 }),
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
    from: place({ id: "wallet", rateNow: 0 }),
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
  assert.match(d.options[0].why, /with your deposit in it/);
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
