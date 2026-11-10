import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approve, draft, type DraftInput } from "./plan.js";
import { loadPeople, loadSeries, readJournal } from "./store.js";

const NOW = new Date("2026-11-10T10:00:00Z");
const PETE = "0x1111111111111111111111111111111111111111";
const ANNA = "0x2222222222222222222222222222222222222222";
const full: DraftInput = {
  label: "Payroll",
  token: "USDC",
  payees: [{ name: "Pete", address: PETE, amount: "50" }, { name: "Anna", address: ANNA, amount: "40.5" }],
  every: { n: 1, unit: "week" },
  first: "2026-11-13T09:00",
  tz: "Europe/Moscow",
};
const questions = (r: ReturnType<typeof draft>) => ("missing" in r ? r.missing : []);

test("a complete request becomes a plan with the wake rule filled in", () => {
  const r = draft(full, {}, NOW);
  assert.ok("plan" in r);
  assert.equal(r.plan.checkEveryMinutes, 1440);
  assert.equal(r.plan.id, "payroll");
  assert.equal(r.plan.payees[1].amount, "40.5");
});

test("the first payment date is always asked when missing", () => {
  assert.deepEqual(questions(draft({ ...full, first: undefined }, {}, NOW)), ["When should the first payment go out (date and time)?"]);
});

test("every gap is one plain question", () => {
  const q = questions(draft({ label: "Payroll", payees: [{ name: "Pete" }] }, {}, NOW));
  assert.ok(q.includes("Which token: USDC or PROS?"));
  assert.ok(q.includes("How much should Pete get each time?"));
  assert.ok(q.includes("What is Pete's wallet address on Pharos?"));
  assert.ok(q.includes("How often: every week, every month, or something else?"));
  assert.ok(q.includes("When should the first payment go out (date and time)?"));
});

test("a known name is filled from the address book", () => {
  const r = draft({ ...full, payees: [{ name: "pete", amount: "50" }] }, { Pete: PETE }, NOW);
  assert.ok("plan" in r);
  assert.equal(r.plan.payees[0].address, PETE);
  assert.equal(r.plan.payees[0].name, "Pete");
});

test("bad amounts and addresses are questions, not crashes", () => {
  const q = questions(draft({ ...full, payees: [{ name: "Pete", address: "0x0000000000000000000000000000000000000000", amount: "0" }, { name: "Anna", address: "0x12", amount: "1.1234567" }] }, {}, NOW));
  assert.ok(q.some((x) => /Pete.*more than zero/.test(x)));
  assert.ok(q.some((x) => /Pete.*zero address/.test(x)));
  assert.ok(q.some((x) => /Anna.*not a Pharos address/.test(x)));
  assert.ok(q.some((x) => /Anna.*6 decimals/.test(x)));
});

test("under an hour the agent has to agree a check interval", () => {
  const e = { ...full, every: { n: 5, unit: "minute" as const }, first: "2026-11-10T13:30" };
  assert.ok(questions(draft(e, {}, NOW)).some((x) => /how often should I check/.test(x)));
  const r = draft({ ...e, checkEveryMinutes: 1 }, {}, NOW);
  assert.ok("plan" in r && r.plan.checkEveryMinutes === 1);
});

test("a first payment already in the past is asked again", () => {
  assert.ok(questions(draft({ ...full, first: "2026-11-01T09:00" }, {}, NOW)).some((x) => /already past/.test(x)));
});

test("the same terms give the same plan id, other terms another", () => {
  const a = draft(full, {}, NOW), b = draft(full, {}, NOW), c = draft({ ...full, first: "2026-11-14T09:00" }, {}, NOW);
  assert.ok("plan" in a && "plan" in b && "plan" in c);
  assert.equal(a.plan.planId, b.plan.planId);
  assert.notEqual(a.plan.planId, c.plan.planId);
});

test("approve turns the draft on once and remembers the names", () => {
  const h = mkdtempSync(join(tmpdir(), "bookkeeper-"));
  const r = draft(full, {}, NOW, h);
  assert.ok("plan" in r);
  const s = approve(h, r.plan.planId, NOW);
  assert.equal(s.status, "active");
  assert.equal(loadSeries(h).length, 1);
  assert.equal(loadPeople(h).Anna, ANNA);
  assert.equal(readJournal(h)[0].kind, "approved");
  assert.throws(() => approve(h, r.plan.planId, NOW), /already approved/);
  assert.throws(() => approve(h, "nope", NOW), /No draft/);
});

test("a payee given only by address is asked about and named by its short address, never 'undefined'", () => {
  const q = questions(draft({ ...full, payees: [{ address: PETE }] as DraftInput["payees"] }, { Anna: ANNA }, NOW));
  assert.deepEqual(q, ["How much should 0x1111…1111 get each time?"]);
  const r = draft({ ...full, payees: [{ address: PETE, amount: "1" }] as DraftInput["payees"] }, { Anna: ANNA }, NOW);
  assert.ok("plan" in r);
  assert.equal(r.plan.payees[0].name, "0x1111…1111");
});

test("an address-only payee does not land in the address book under its short address", () => {
  const h = mkdtempSync(join(tmpdir(), "bookkeeper-"));
  const r = draft({ ...full, payees: [{ address: PETE, amount: "1" }, { name: "Anna", address: ANNA, amount: "2" }] as DraftInput["payees"] }, {}, NOW, h);
  assert.ok("plan" in r);
  approve(h, r.plan.planId, NOW);
  assert.deepEqual(loadPeople(h), { Anna: ANNA });
});

test("a lower-case address-only payee also stays out of the address book", () => {
  const h = mkdtempSync(join(tmpdir(), "bookkeeper-"));
  const lower = "0x3759d28c86476de18a901747c68816369006a6e9";
  const r = draft({ ...full, payees: [{ address: lower, amount: "1" }] as DraftInput["payees"] }, {}, NOW, h);
  assert.ok("plan" in r);
  assert.equal(r.plan.payees[0].name, "0x3759…A6e9");
  approve(h, r.plan.planId, NOW);
  assert.deepEqual(loadPeople(h), {});
});
