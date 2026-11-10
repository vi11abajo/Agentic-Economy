process.env.TZ = "UTC";
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronLines, scheduleFor, taskXml } from "./schedule.js";
import type { Series } from "./store.js";

const s = (over: Partial<Series>): Series => ({ id: "payroll", label: "Payroll", token: "USDC", payees: [], every: { n: 1, unit: "week" }, first: "2026-11-13T09:00", tz: "UTC", checkEveryMinutes: 1440, status: "active", approvedAt: "", planId: "x", ...over });
const NOW = new Date("2026-11-14T10:00:00Z");

test("weekly payroll: a daily check anchored at the first payment, and one exact wake at the next payday", () => {
  const p = scheduleFor([s({})], NOW)!;
  assert.equal(p.checkEveryMinutes, 1440);
  assert.equal(p.anchor.toISOString(), "2026-11-13T09:00:00.000Z");
  assert.equal(p.nextDue?.toISOString(), "2026-11-20T09:00:00.000Z");
  const check = taskXml("check", p, "C:\\bk\\run.cmd");
  assert.ok(check.includes("<StartBoundary>2026-11-13T09:00:00</StartBoundary>"));
  assert.ok(check.includes("<Interval>P1D</Interval>"));
  assert.ok(check.includes("<StartWhenAvailable>true</StartWhenAvailable>"));
  assert.ok(check.includes("<Arguments>run</Arguments>"));
  const due = taskXml("due", p, "C:\\bk\\run.cmd");
  assert.ok(due.includes("<StartBoundary>2026-11-20T09:00:00</StartBoundary>"));
  assert.ok(!due.includes("<Repetition>"));
});

test("the shortest check interval of all active series wins; stopped ones don't count", () => {
  const p = scheduleFor([s({ id: "rent", every: { n: 1, unit: "month" }, checkEveryMinutes: 10080 }), s({ id: "demo", every: { n: 5, unit: "minute" }, first: "2026-11-14T09:00", checkEveryMinutes: 1 }), s({ id: "old", checkEveryMinutes: 60, status: "stopped" })], NOW)!;
  assert.equal(p.checkEveryMinutes, 1);
  assert.ok(taskXml("check", p, "r").includes("<Interval>PT1M</Interval>"));
  assert.equal(p.nextDue?.toISOString(), "2026-11-14T10:05:00.000Z");
});

test("monthly only: weekly check", () => {
  const p = scheduleFor([s({ every: { n: 1, unit: "month" }, checkEveryMinutes: 10080 })], NOW)!;
  assert.ok(taskXml("check", p, "r").includes("<Interval>P7D</Interval>"));
});

test("nothing active: nothing to schedule", () => {
  assert.equal(scheduleFor([s({ status: "stopped" })], NOW), null);
});

test("cron: the check line by interval and a dated line for the next payment, other lines kept", () => {
  const p = scheduleFor([s({})], NOW)!;
  const text = cronLines("0 1 * * * backup.sh\n", p, "/home/u/.config/bookkeeper/run.sh");
  assert.ok(text.startsWith("0 1 * * * backup.sh\n"));
  assert.ok(text.includes("0 9 * * * '/home/u/.config/bookkeeper/run.sh' run # bookkeeper"));
  assert.ok(text.includes("0 9 20 11 * '/home/u/.config/bookkeeper/run.sh' run # bookkeeper"));
  const fast = scheduleFor([s({ every: { n: 5, unit: "minute" }, checkEveryMinutes: 1, first: "2026-11-14T09:00" })], NOW)!;
  assert.ok(cronLines("", fast, "/r.sh").includes("*/1 * * * * '/r.sh' run # bookkeeper"));
  assert.equal(cronLines("x\n0 9 * * * '/r.sh' run # bookkeeper\n", null, "/r.sh"), "x\n");
});
