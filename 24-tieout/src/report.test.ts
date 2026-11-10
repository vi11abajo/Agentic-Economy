import assert from "node:assert/strict";
import { test } from "node:test";
import { booksCsv, fingerprint, transactionsCsv } from "./csv.js";
import { ALICE, BOB, FakeWorld, ME, POOL, ROUTER, T0, TACO, USDC, VAULT, approvalLog, swapLog, transferLog } from "./fake.js";
import type { Hex } from "./explorer.js";
import { markdown } from "./markdown.js";
import { pdf } from "./pdf.js";
import { buildReport, UNLIMITED, type Report } from "./report.js";
import { describe as words, summary } from "./words.js";

const CAROL = "0x00000000000000000000000000000000000000c4" as Hex;
const E18 = 10n ** 18n;
const period = { from: T0 + 101, to: T0 + 200, zone: "UTC" };

// One busy period: every category once, plus history before it so "first contact" has something to compare with.
function busyWallet() {
  const w = new FakeWorld();
  w.move("native", 1, 10n * E18);
  w.add({ n: 90, block: 50, from: ALICE, to: USDC, listed: false, logs: [transferLog(USDC, ALICE, ME, 10_000_000n)] });
  w.add({ n: 91, block: 60, to: USDC, method: "Transfer", logs: [transferLog(USDC, ME, BOB, 1_000_000n)] });

  const h = {
    paidBob: w.add({ n: 1, block: 110, to: USDC, method: "Transfer", logs: [transferLog(USDC, ME, BOB, 2_000_000n)] }),
    paidCarol: w.add({ n: 2, block: 120, to: USDC, method: "Transfer", logs: [transferLog(USDC, ME, CAROL, 1_000_000n)] }),
    prosToAlice: w.add({ n: 3, block: 130, to: ALICE, value: "0.5", methodId: "0x" }),
    swap: w.add({
      n: 4,
      block: 140,
      to: ROUTER,
      value: "0.3",
      method: "Swap Eth For Exact Tokens",
      internals: [{ from: ROUTER, to: ME, value: "0.1" }],
      logs: [swapLog(POOL), transferLog(TACO, POOL, ME, 5_000_000n)],
    }),
    approve: w.add({ n: 5, block: 150, to: USDC, method: "Approve", methodId: "0x095ea7b3", logs: [approvalLog(USDC, ME, VAULT, 2n ** 256n - 1n)] }),
    deposit: w.add({ n: 6, block: 160, to: VAULT, method: "Deposit", logs: [approvalLog(USDC, ME, VAULT, 2n ** 256n - 1n - 3_000_000n), transferLog(USDC, ME, VAULT, 3_000_000n)] }),
    failed: w.add({ n: 7, block: 170, to: ROUTER, method: "Swap", ok: false, fee: 5000n }),
    fromAlice: w.add({ n: 8, block: 180, from: ALICE, to: USDC, listed: false, logs: [transferLog(USDC, ALICE, ME, 1_000_000n)] }),
  };
  w.allowances.set(`${USDC}:${VAULT}`, 2n ** 256n - 1n - 3_000_000n);
  return { w, h };
}

const report = (w: FakeWorld) => buildReport(w.chain(), w.explorer(), ME, period);
const entry = (r: Report, hash: Hex) => r.entries.find((e) => e.hash === hash)!;

test("every transaction in the period lands in the category an accountant would put it in", async () => {
  const { w, h } = busyWallet();
  const r = await report(w);
  assert.equal(r.openBlock, 100n);
  assert.equal(r.closeBlock, 200n);
  assert.equal(r.entries.length, 8, "history before the period stays out");
  assert.equal(entry(r, h.paidBob).category, "transfer_out");
  assert.equal(entry(r, h.paidCarol).category, "transfer_out");
  assert.equal(entry(r, h.prosToAlice).category, "transfer_out");
  assert.equal(entry(r, h.swap).category, "swap");
  assert.equal(entry(r, h.approve).category, "approval");
  assert.equal(entry(r, h.deposit).category, "contract");
  assert.equal(entry(r, h.failed).category, "failed");
  assert.equal(entry(r, h.fromAlice).category, "transfer_in");
});

test("the router's change is folded into the swap instead of showing up as money received", async () => {
  const { w, h } = busyWallet();
  const r = await report(w);
  const swap = entry(r, h.swap);
  const pros = swap.flows.filter((f) => f.asset === "native");
  assert.deepEqual(pros.map((f) => [f.dir, f.amount]), [["out", 2n * 10n ** 17n]]);
  assert.match(words(r, swap), /^swapped 0\.2 PROS for 5 TACO via Router$/);
});

test("an Approval event fired inside a deposit is not counted as the user approving something", async () => {
  const { w, h } = busyWallet();
  const r = await report(w);
  assert.equal(entry(r, h.deposit).approvals.length, 0);
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].hash, h.approve);
});

test("when nothing is missing, every asset ties to the unit, gas included", async () => {
  const { w } = busyWallet();
  const r = await report(w);
  assert.ok(r.books.length >= 3);
  for (const l of r.books) assert.equal(l.gap, 0n, `${l.asset} should tie`);
  const pros = r.books.find((l) => l.asset === "native")!;
  assert.equal(pros.fees, 1000n * 6n + 5000n, "gas of the six sent transactions plus the failed one");
  assert.match(summary(r).join(" "), /The books tie out: for all \d+ assets/);
});

test("a balance that moves without any transfer breaks the tie-out and the report says by how much", async () => {
  const { w } = busyWallet();
  w.move(TACO, 190, 250_000n); // interest, a rebase, or a transfer the explorer never listed
  const r = await report(w);
  const taco = r.books.find((l) => l.asset === TACO)!;
  assert.equal(taco.gap, 250_000n);
  const gap = r.notables.find((n) => n.kind === "gap")!;
  assert.match(gap.why, /TACO doesn't tie: the closing balance is higher than the transactions explain by 0\.25 TACO/);
  assert.match(summary(r).join(" "), /do NOT fully tie: 1 of/);
});

test("the second look lists the failed tx, the unlimited approval that is still open and the first payment to a new address", async () => {
  const { w, h } = busyWallet();
  const r = await report(w);
  const kinds = r.notables.map((n) => `${n.kind}:${n.hash ?? ""}`);
  assert.ok(kinds.includes(`failed:${h.failed}`));
  assert.ok(kinds.includes(`unlimited:${h.approve}`));
  assert.ok(kinds.includes(`still_open:${h.approve}`));
  assert.ok(kinds.includes(`new_counterparty:${h.paidCarol}`), "Carol was never paid before");
  assert.ok(!kinds.includes(`new_counterparty:${h.paidBob}`), "Bob was paid before the period");
  assert.ok(kinds.includes(`new_contract:${h.deposit}`), "first call to the vault");
  assert.ok(r.approvals[0].left! >= UNLIMITED);
});

test("first contact is skipped when the explorer can't show the wallet's whole history", async () => {
  const { w } = busyWallet();
  w.cut = true;
  const r = await report(w);
  assert.ok(!r.notables.some((n) => n.kind === "new_counterparty" || n.kind === "new_contract"));
  assert.match(summary(r).join(" "), /first contact' check is skipped/);
});

test("CSV puts gas on one row per transaction and the fingerprint only changes when the data does", async () => {
  const { w } = busyWallet();
  const r = await report(w);
  const rows = transactionsCsv(r).trim().split("\n");
  assert.equal(rows[0].split(",")[12], "gas_fee_pros");
  const gasCells = rows.slice(1).filter((l) => l.split(",")[12] !== "");
  assert.equal(gasCells.length, 7, "seven transactions were sent by the wallet itself");
  assert.match(booksCsv(r), /\nUSDC,0x00000000000000000000000000000000000000C0,/);
  assert.equal(fingerprint(r), fingerprint(await report(busyWallet().w)));
  const { w: w2 } = busyWallet();
  w2.move(TACO, 190, 1n);
  assert.notEqual(fingerprint(r), fingerprint(await report(w2)));
});

test("the Markdown and the PDF carry the same tie-out and link every transaction", async () => {
  const { w, h } = busyWallet();
  const r = await report(w);
  const md = markdown(r, new Date("2026-11-10T00:00:00Z"));
  assert.match(md, /## Does it add up/);
  assert.match(md, /\| \[TACO\]\([^)]+\) \| 0 \| 5 \| 0 \| {2}\| 5 \| 5 \| ✔ ties \|/);
  assert.ok(md.includes(`https://www.pharosscan.xyz/tx/${h.paidCarol}`));
  assert.doesNotMatch(md, /—/);

  const file = pdf(r, new Date("2026-11-10T00:00:00Z")).toString("latin1");
  assert.ok(file.startsWith("%PDF-1.4"));
  assert.ok(file.includes(`/URI (https://www.pharosscan.xyz/tx/${h.paidCarol})`));
  // every offset in the xref table has to point at the start of its object, or readers complain
  const xrefAt = Number(/startxref\n(\d+)/.exec(file)![1]);
  const offsets = file.slice(xrefAt).match(/^\d{10} 00000 n $/gm)!.map((l) => Number(l.slice(0, 10)));
  offsets.forEach((o, i) => assert.ok(file.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1} offset`));
});
