import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { anchorFor, dueAt, lastClosedPeriod, previousPeriod } from "./period.js";
import type { Schedule } from "./store.js";

const iso = (s: string) => Date.parse(s) / 1000;
const weekly: Schedule = { days: 7, weekday: 1, time: "09:00", tz: "Europe/Moscow", anchor: "2026-01-05" };

describe("periods", () => {
  it("the last closed week before Tuesday 2026-11-03 is Oct 26 - Nov 1, ISO week 44", () => {
    const p = lastClosedPeriod(iso("2026-11-03T09:00:00Z"), weekly);
    assert.equal(p.key, "2026-10-26_7d");
    assert.equal(p.label, "2026-W44");
    assert.equal(p.start, iso("2026-10-26T00:00:00Z"));
    assert.equal(p.end, iso("2026-11-02T00:00:00Z"));
  });

  it("at exactly a period boundary the period that just ended is the last closed one", () => {
    assert.equal(lastClosedPeriod(iso("2026-11-02T00:00:00Z"), weekly).key, "2026-10-26_7d");
  });

  it("tiles 3-day periods from the anchor and labels them with dates", () => {
    const s = { ...weekly, days: 3 };
    const p = lastClosedPeriod(iso("2026-01-12T05:00:00Z"), s);
    assert.equal(p.key, "2026-01-08_3d");
    assert.equal(p.label, "Jan 8 - Jan 10");
    assert.equal(previousPeriod(p).key, "2026-01-05_3d");
  });

  it("is due at the next Monday 09:00 Moscow time after the week ends", () => {
    const p = lastClosedPeriod(iso("2026-11-03T09:00:00Z"), weekly);
    assert.equal(dueAt(p, weekly), iso("2026-11-02T06:00:00Z"));
  });

  it("a Friday 18:00 schedule gets Friday-to-Thursday weeks, due the day after they end", () => {
    const s = { ...weekly, weekday: 5, time: "18:00", tz: "Europe/Paris" };
    s.anchor = anchorFor(s);
    const p = lastClosedPeriod(iso("2026-11-06T17:30:00Z"), s);
    assert.equal(p.end, iso("2026-11-06T00:00:00Z"));
    assert.equal(dueAt(p, s), iso("2026-11-06T17:00:00Z"));
  });

  it("Monday 09:00 east of UTC (Sunday 23:00 UTC) reports the week that just ended, not the one before", () => {
    const s = { ...weekly, tz: "Australia/Brisbane" };
    s.anchor = anchorFor(s);
    const fire = iso("2026-11-01T23:00:00Z"); // Monday 09:00 in Brisbane
    const p = lastClosedPeriod(fire, s);
    assert.equal(p.end, iso("2026-11-01T00:00:00Z"));
    assert.equal(dueAt(p, s), fire);
  });

  it("is due at the first 18:00 local after a 3-day period ends", () => {
    const s = { ...weekly, days: 3, time: "18:00", tz: "UTC" };
    const p = lastClosedPeriod(iso("2026-01-12T05:00:00Z"), s);
    assert.equal(dueAt(p, s), iso("2026-01-11T18:00:00Z"));
  });
});
