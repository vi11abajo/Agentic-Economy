import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Card, Notifier } from "./cards.js";
import { FakeChain } from "./fake.js";
import { paymentNonce } from "./pay.js";
import { runOnce, runway, paymentStates } from "./run.js";
import { appendJournal, readJournal, saveSeries, type Series } from "./store.js";

const agent = privateKeyToAccount(("0x" + "ab".repeat(32)) as `0x${string}`);
const PETE = "0x1111111111111111111111111111111111111111" as const;
const ANNA = "0x2222222222222222222222222222222222222222" as const;
const USDC6 = (x: number) => BigInt(Math.round(x * 1e6));

const payroll = (over: Partial<Series> = {}): Series => ({
  id: "payroll",
  label: "Payroll",
  token: "USDC",
  payees: [{ name: "Pete", address: PETE, amount: "0.1" }, { name: "Anna", address: ANNA, amount: "0.05" }],
  every: { n: 1, unit: "week" },
  first: "2026-11-13T09:00",
  tz: "UTC",
  checkEveryMinutes: 1440,
  status: "active",
  approvedAt: "2026-11-10T10:00:00Z",
  planId: "abc",
  ...over,
});

class Inbox implements Notifier {
  cards: Card[] = [];
  down = false;
  channels = ["test"];
  async send(c: Card) {
    if (this.down) throw new Error("telegram is down");
    this.cards.push(c);
  }
  of(kind: Card["kind"]) {
    return this.cards.filter((c) => c.kind === kind);
  }
}

function world(series: Series[] = [payroll()]) {
  const home = mkdtempSync(join(tmpdir(), "bookkeeper-"));
  saveSeries(home, series);
  const chain = new FakeChain();
  chain.setUsdc(agent.address, USDC6(1));
  chain.setPros(agent.address, 10n ** 17n);
  const inbox = new Inbox();
  const at = (iso: string) => {
    const now = new Date(iso);
    chain.time = BigInt(Math.floor(now.getTime() / 1000));
    return runOnce({ home, chain, account: agent, now, notify: inbox, sleep: async () => {} });
  };
  return { home, chain, inbox, at };
}

test("before the first due time nothing is paid and the next payment is known", async () => {
  const w = world();
  const r = await w.at("2026-11-12T09:00:00Z");
  assert.equal(r.paid, 0);
  assert.equal(w.chain.sent.length, 0);
  assert.equal(r.nextDue, "2026-11-13T09:00:00.000Z");
});

test("a due period is paid to everyone once, one card for the period, and a re-run pays nothing", async () => {
  const w = world();
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.paid, 2);
  assert.equal(await w.chain.usdcBalance(PETE), USDC6(0.1));
  assert.equal(await w.chain.usdcBalance(ANNA), USDC6(0.05));
  const paid = w.inbox.of("paid");
  assert.equal(paid.length, 1);
  assert.equal(paid[0].kind === "paid" && paid[0].lines.length, 2);
  const again = await w.at("2026-11-13T15:00:00Z");
  assert.equal(again.paid, 0);
  assert.equal(w.chain.sent.length, 2);
  assert.equal(w.inbox.of("paid").length, 1);
  assert.equal(r.nextDue, "2026-11-20T09:00:00.000Z");
});

test("a payment the chain already has (crash after broadcast) is recorded as paid, nothing is sent", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  const nonce = paymentNonce(agent.address, "payroll", "abc", 0, 0);
  w.chain.used.set(`${agent.address.toLowerCase()}:${nonce}`, ("0x" + "cd".repeat(32)) as `0x${string}`);
  const r = await w.at("2026-11-13T09:05:00Z");
  assert.equal(w.chain.sent.length, 0);
  assert.equal(r.paid, 1);
  const paid = readJournal(w.home).find((e) => e.kind === "paid");
  assert.equal(paid?.tx, "0x" + "cd".repeat(32));
});

test("short balance: one notice however many wakes, then paid after the top-up", async () => {
  const w = world();
  w.chain.setUsdc(agent.address, USDC6(0.12));
  await w.at("2026-11-13T09:00:30Z"); // Pete 0.1 paid, Anna short (0.02 left)
  await w.at("2026-11-13T10:00:00Z");
  await w.at("2026-11-13T11:00:00Z");
  const short = w.inbox.of("short");
  assert.equal(short.length, 1);
  assert.equal(short[0].kind === "short" && short[0].name, "Anna");
  assert.equal(short[0].kind === "short" && short[0].need, "0.05");
  assert.equal(short[0].kind === "short" && short[0].have, "0.02");
  w.chain.setUsdc(agent.address, USDC6(0.2));
  const r = await w.at("2026-11-13T12:00:00Z");
  assert.equal(r.paid, 1);
  assert.equal(await w.chain.usdcBalance(ANNA), USDC6(0.05));
  assert.equal(await w.chain.usdcBalance(PETE), USDC6(0.1));
});

test("a period whose window closed unpaid is missed, told once, never paid late", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  w.chain.setUsdc(agent.address, 0n);
  await w.at("2026-11-13T09:01:00Z");
  w.chain.setUsdc(agent.address, USDC6(1));
  // the PC was off for the rest of the week; next wake is after period 1 is due
  const r = await w.at("2026-11-20T09:10:00Z");
  assert.equal(w.inbox.of("missed").length, 1);
  assert.equal(r.paid, 1); // period 1 only
  assert.equal(await w.chain.usdcBalance(PETE), USDC6(0.1));
  await w.at("2026-11-20T10:00:00Z");
  assert.equal(w.inbox.of("missed").length, 1);
  const states = paymentStates(payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] }), readJournal(w.home), new Date("2026-11-20T10:00:00Z"));
  assert.deepEqual(states.map((s) => s.status), ["missed", "paid"]);
});

test("a stopped series never pays", async () => {
  const w = world([payroll({ status: "stopped" })]);
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.paid, 0);
  assert.equal(w.chain.sent.length, 0);
});

test("PROS: a signed tx the node lost is re-sent as the same bytes, never rebuilt", async () => {
  const w = world([payroll({ token: "PROS", payees: [{ name: "Pete", address: PETE, amount: "0.01" }] })]);
  w.chain.holdInPool = true;
  const r1 = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r1.paid, 0);
  assert.equal(w.chain.sent.length, 1);
  w.chain.pool.clear(); // the node forgot it
  await w.at("2026-11-13T10:00:00Z");
  assert.equal(w.chain.sent.length, 1); // same hash again
  assert.equal(w.chain.pool.size, 1);
  await w.chain.mine();
  const r3 = await w.at("2026-11-13T11:00:00Z");
  assert.equal(r3.paid, 1);
  assert.equal(await w.chain.prosBalance(PETE), 10n ** 16n);
});

test("a send the node refuses is a failed attempt, told once, and retried next wake", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  w.chain.refuse = "replacement transaction underpriced";
  const r1 = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r1.failed, 1);
  assert.equal(w.inbox.of("failed").length, 1);
  w.chain.refuse = null;
  const r2 = await w.at("2026-11-13T10:00:00Z");
  assert.equal(r2.paid, 1);
  assert.equal(await w.chain.usdcBalance(PETE), USDC6(0.1));
});

test("a lost response after the node took the tx is not a failure", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  w.chain.dropResponse = true;
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.failed, 0);
  assert.equal(r.paid, 1);
});

test("the local clock a little ahead of the chain is not a failure", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  const now = new Date("2026-11-13T09:00:01Z");
  w.chain.time = BigInt(Math.floor(now.getTime() / 1000)) - 5n;
  const r = await runOnce({ home: w.home, chain: w.chain, account: agent, now, notify: w.inbox, sleep: async () => {} });
  assert.equal(r.failed, 0);
  assert.equal(w.chain.sent.length, 0);
  assert.equal(readJournal(w.home).filter((e) => e.kind === "failed").length, 0);
});

test("Telegram down: the payment stands and the card goes out on the next run", async () => {
  const w = world();
  w.inbox.down = true;
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.paid, 2);
  assert.ok(r.undelivered > 0);
  w.inbox.down = false;
  await w.at("2026-11-13T10:00:00Z");
  assert.equal(w.inbox.of("paid").length, 1);
  assert.equal(w.chain.sent.length, 2);
});

test("a second run while one holds the lock does nothing", async () => {
  const w = world();
  writeFileSync(join(w.home, "run.lock"), String(process.pid));
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.skipped, "locked");
  assert.equal(w.chain.sent.length, 0);
});

test("runway: how many coming periods the wallet covers, and whether the next one is short", () => {
  const s = payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }, { name: "Anna", address: ANNA, amount: "0.1" }] });
  const now = new Date("2026-11-13T10:00:00Z");
  const [a] = runway([s], { usdc: USDC6(0.5), pros: 10n ** 18n }, now, 0n);
  assert.equal(a.coversPeriods, 2);
  assert.equal(a.until, "2026-11-27T09:00:00.000Z");
  assert.equal(a.nextShort, false);
  const [b] = runway([s], { usdc: USDC6(0.15), pros: 10n ** 18n }, now, 0n);
  assert.equal(b.coversPeriods, 0);
  assert.equal(b.nextShort, true);
  const [c] = runway([s], { usdc: USDC6(10), pros: 3n }, now, 1n);
  assert.equal(c.coversPeriods, 1); // gas: 2 payments per period, 1 wei each, 3 wei of PROS
});

test("after payouts the runway goes out, and a short next period is warned about once", async () => {
  const w = world();
  w.chain.setUsdc(agent.address, USDC6(0.2)); // pays period 0 (0.15), 0.05 left < next 0.15
  await w.at("2026-11-13T09:00:30Z");
  const rw = w.inbox.of("runway");
  assert.equal(rw.length, 1);
  assert.equal(rw[0].kind === "runway" && rw[0].lines[0].nextShort, true);
  await w.at("2026-11-14T09:00:00Z");
  assert.equal(w.inbox.of("runway").length, 1);
  appendJournal(w.home, { at: "x", series: "payroll", period: -1, payee: -1, kind: "stopped" });
});

// ---- final review fixes ----

test("PROS: an unclear broadcast that the node did take is never paid twice", async () => {
  const w = world([payroll({ token: "PROS", payees: [{ name: "Pete", address: PETE, amount: "0.01" }] })]);
  w.chain.holdInPool = true;
  w.chain.dropResponse = true;
  w.chain.hidePool = true; // a lagging node: the tx is in some pool but this one can't see it yet
  const r1 = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r1.failed, 0);
  await w.chain.mine();
  w.chain.dropResponse = false;
  const r2 = await w.at("2026-11-13T10:00:00Z");
  assert.equal(r2.paid, 1);
  await w.at("2026-11-13T11:00:00Z");
  assert.equal(w.chain.sent.length, 1);
  assert.equal(await w.chain.prosBalance(PETE), 10n ** 16n);
});

test("PROS: a receipt lookup that errors is not read as 'dropped'", async () => {
  const w = world([payroll({ token: "PROS", payees: [{ name: "Pete", address: PETE, amount: "0.01" }] })]);
  w.chain.holdInPool = true;
  await w.at("2026-11-13T09:00:30Z");
  await w.chain.mine();
  w.chain.rpcDown = true;
  const r2 = await w.at("2026-11-13T10:00:00Z");
  assert.equal(r2.failed, 0);
  w.chain.rpcDown = false;
  const r3 = await w.at("2026-11-13T11:00:00Z");
  assert.equal(r3.paid, 1);
  assert.equal(w.chain.sent.length, 1);
  assert.equal(await w.chain.prosBalance(PETE), 10n ** 16n);
});

test("PROS: a tx whose nonce was taken by another one is flagged for the user, not rebuilt on its own", async () => {
  const w = world([payroll({ token: "PROS", payees: [{ name: "Pete", address: PETE, amount: "0.01" }] })]);
  w.chain.holdInPool = true;
  await w.at("2026-11-13T09:00:30Z");
  w.chain.pool.clear();
  w.chain.nonces.set(agent.address.toLowerCase(), 1); // something else used nonce 0
  await w.at("2026-11-13T10:00:00Z");
  await w.at("2026-11-13T11:00:00Z");
  assert.equal(w.chain.sent.length, 1);
  const failed = w.inbox.of("failed");
  assert.equal(failed.length, 1);
  assert.match(failed[0].kind === "failed" ? failed[0].reason : "", /check it yourself/);
});

test("a stopped series does not pile up missed periods or cards", async () => {
  const w = world([payroll({ status: "stopped" })]);
  const r = await w.at("2026-11-27T10:00:00Z");
  assert.equal(r.missed, 0);
  assert.equal(w.inbox.cards.length, 0);
});

test("one payee whose payment can't even be estimated doesn't block the others", async () => {
  const w = world([payroll({ token: "PROS", payees: [{ name: "Pete", address: PETE, amount: "0.01" }, { name: "Anna", address: ANNA, amount: "0.01" }] })]);
  w.chain.estimateFailsFor = PETE;
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.paid, 1);
  assert.equal(r.failed, 1);
  assert.equal(await w.chain.prosBalance(ANNA), 10n ** 16n);
  assert.equal(w.inbox.of("paid").length, 1);
});

test("the same refusal over many wakes is one card", async () => {
  const w = world([payroll({ payees: [{ name: "Pete", address: PETE, amount: "0.1" }] })]);
  w.chain.refuseSimulation = "FiatTokenV2: account is blacklisted";
  await w.at("2026-11-13T09:00:30Z");
  await w.at("2026-11-13T10:00:00Z");
  await w.at("2026-11-13T11:00:00Z");
  assert.equal(w.inbox.of("failed").length, 1);
});

test("a lock left by a run that died long ago doesn't stop payments, even if its pid is alive again", async () => {
  const w = world();
  writeFileSync(join(w.home, "run.lock"), `${process.pid} ${Date.now() - 40 * 60_000}`);
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.skipped, undefined);
  assert.equal(r.paid, 2);
});

test("a lock file being written right now (still empty) counts as held", async () => {
  const w = world();
  writeFileSync(join(w.home, "run.lock"), "");
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.skipped, "locked");
});

test("an old lock holding only a pid that Windows gave to another live process is stale", async () => {
  const w = world();
  const f = join(w.home, "run.lock");
  writeFileSync(f, String(process.pid));
  const old = new Date(Date.now() - 40 * 60_000);
  utimesSync(f, old, old);
  const r = await w.at("2026-11-13T09:00:30Z");
  assert.equal(r.skipped, undefined);
  assert.equal(r.paid, 2);
});
