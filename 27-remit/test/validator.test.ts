import test from "node:test";
import assert from "node:assert/strict";
import { parseInvoice } from "../src/parser/index.js";
import { validateInvoice } from "../src/validator.js";

const PAYEE = "0xa991b44106b336b547259bd2b9b2f45931414348";
const stops = (file: string) =>
  validateInvoice(parseInvoice(file)).flags.filter((f) => f.severity === "FATAL").map((f) => f.code);

test("the four valid samples pass the paper check", () => {
  for (const f of ["01-hosting.json", "02-freelance.md", "03-audit.pdf", "04-checkout-qr.png"]) {
    const r = validateInvoice(parseInvoice(`samples/${f}`));
    assert.equal(r.ok, true, `${f}: ${r.flags.map((x) => x.message).join("; ")}`);
  }
  assert.equal(validateInvoice(parseInvoice("samples/01-hosting.json")).invoice?.amountRaw, 300000n);
});

test("totals that disagree are flagged, not corrected", () => {
  const r = validateInvoice(parseInvoice("samples/05-totals-disagree.json"));
  assert.equal(r.ok, false);
  assert.match(r.flags.find((f) => f.code === "MATH_MISMATCH")!.message, /total says 0\.90/);
});

test("missing reference, bare dollars, broken checksum, tutorial key, wrong chain", () => {
  assert.deepEqual(stops("samples/06-no-reference.txt"), ["MISSING_FIELD"]);
  assert.deepEqual(stops("samples/07-just-dollars.json"), ["AMBIGUOUS_CURRENCY"]);
  assert.deepEqual(stops("samples/08-typo-in-address.txt"), ["INVALID_PAYEE"]);
  assert.deepEqual(stops("samples/09-tutorial-address.txt"), ["DANGEROUS_PAYEE"]);
  assert.deepEqual(stops("samples/10-ethereum-qr.png"), ["WRONG_CHAIN"]);
});

test("token contract as payee, too many decimals, past due", () => {
  const base = { format: "json" as const, reference: "R", currency: "USDC" };
  const codes = (r: ReturnType<typeof validateInvoice>) => r.flags.map((f) => f.code);
  assert.deepEqual(codes(validateInvoice({ ...base, payee: "0xc879c018db60520f4355c26ed1a6d572cdac1815", amount: "1" })), ["DANGEROUS_PAYEE"]);
  assert.deepEqual(codes(validateInvoice({ ...base, payee: PAYEE, amount: "1.0000001" })), ["MATH_MISMATCH"]);
  const now = Date.parse("2026-11-14");
  assert.equal(validateInvoice({ ...base, payee: PAYEE, amount: "1", dueDate: "2026-01-01" }, { now }).ok, false);
  assert.equal(validateInvoice({ ...base, payee: PAYEE, amount: "1", dueDate: "2026-01-01" }, { now, allowExpired: true }).ok, true);
});

test("a picture with no QR code is unreadable, not empty", () => {
  const r = validateInvoice({ format: "qr", problem: "no QR code found in the picture" });
  assert.equal(r.flags[0].code, "UNREADABLE");
});
