import { test } from "node:test";
import assert from "node:assert/strict";
import { checkEveryMinutes, describeEvery, dueAt, indexAt } from "./period.js";

test("weekly on a Moscow Friday morning lands on the same wall clock a week later", () => {
  const first = "2026-11-13T09:00";
  assert.equal(dueAt(first, "Europe/Moscow", { n: 1, unit: "week" }, 0).toISOString(), "2026-11-13T06:00:00.000Z");
  assert.equal(dueAt(first, "Europe/Moscow", { n: 1, unit: "week" }, 1).toISOString(), "2026-11-20T06:00:00.000Z");
});

test("monthly from the 31st clamps to the end of short months and comes back to the 31st", () => {
  const e = { n: 1, unit: "month" } as const;
  assert.equal(dueAt("2026-01-31T10:00", "UTC", e, 1).toISOString(), "2026-02-28T10:00:00.000Z");
  assert.equal(dueAt("2026-01-31T10:00", "UTC", e, 2).toISOString(), "2026-03-31T10:00:00.000Z");
});

test("daily keeps the local wall clock across a DST change", () => {
  // New York leaves DST on 2026-11-01: 09:00 local is 13:00Z before and 14:00Z after.
  const e = { n: 1, unit: "day" } as const;
  assert.equal(dueAt("2026-10-31T09:00", "America/New_York", e, 0).toISOString(), "2026-10-31T13:00:00.000Z");
  assert.equal(dueAt("2026-10-31T09:00", "America/New_York", e, 1).toISOString(), "2026-11-01T14:00:00.000Z");
});

test("minutes and hours are plain arithmetic", () => {
  assert.equal(dueAt("2026-11-10T12:00", "UTC", { n: 5, unit: "minute" }, 3).toISOString(), "2026-11-10T12:15:00.000Z");
  assert.equal(dueAt("2026-11-10T12:00", "UTC", { n: 3, unit: "hour" }, 2).toISOString(), "2026-11-10T18:00:00.000Z");
});

test("indexAt finds the latest period that is due, -1 before the first", () => {
  const e = { n: 1, unit: "week" } as const;
  assert.equal(indexAt("2026-11-13T09:00", "UTC", e, new Date("2026-11-13T08:59:59Z")), -1);
  assert.equal(indexAt("2026-11-13T09:00", "UTC", e, new Date("2026-11-13T09:00:00Z")), 0);
  assert.equal(indexAt("2026-11-13T09:00", "UTC", e, new Date("2026-11-27T10:00:00Z")), 2);
  assert.equal(indexAt("2026-01-31T10:00", "UTC", { n: 1, unit: "month" }, new Date("2026-03-30T00:00:00Z")), 1);
});

test("the user's wake rule: one unit below the period, agreed interval under an hour", () => {
  assert.equal(checkEveryMinutes({ n: 1, unit: "month" }), 10080);
  assert.equal(checkEveryMinutes({ n: 1, unit: "week" }), 1440);
  assert.equal(checkEveryMinutes({ n: 3, unit: "week" }), 1440);
  assert.equal(checkEveryMinutes({ n: 1, unit: "day" }), 60);
  assert.equal(checkEveryMinutes({ n: 3, unit: "hour" }), 60);
  assert.equal(checkEveryMinutes({ n: 1, unit: "hour" }), 60);
  assert.equal(checkEveryMinutes({ n: 5, unit: "minute" }), null);
  assert.equal(checkEveryMinutes({ n: 5, unit: "minute" }, 1), 1);
  assert.equal(checkEveryMinutes({ n: 90, unit: "minute" }), 60);
});

test("describeEvery reads like a person", () => {
  assert.equal(describeEvery({ n: 1, unit: "week" }, "2026-11-13T09:00"), "every week on Friday at 09:00");
  assert.equal(describeEvery({ n: 2, unit: "week" }, "2026-11-13T09:00"), "every 2 weeks on Friday at 09:00");
  assert.equal(describeEvery({ n: 1, unit: "month" }, "2026-01-31T10:00"), "every month on the 31st at 10:00 (last day in shorter months)");
  assert.equal(describeEvery({ n: 5, unit: "minute" }, "2026-11-10T12:00"), "every 5 minutes");
});
