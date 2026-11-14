import test from "node:test";
import assert from "node:assert/strict";
import { parseInvoice, parsePaymentLink } from "../src/parser/index.js";
import { exactInteger } from "../src/parser/image.js";

const PAYEE = "0xa991b44106b336b547259bd2b9b2f45931414348";

test("json invoice: number, payee, token, items", () => {
  const raw = parseInvoice("samples/01-hosting.json");
  assert.equal(raw.format, "json");
  assert.equal(raw.reference, "INV-2026-1107");
  assert.equal(raw.payee?.toLowerCase(), PAYEE);
  assert.equal(raw.currency, "USDC");
  assert.equal(Number(raw.amount), 0.3);
  assert.equal(raw.items?.length, 2);
});

test("markdown invoice: table rows become line items", () => {
  const raw = parseInvoice("samples/02-freelance.md");
  assert.equal(raw.format, "text");
  assert.equal(raw.reference, "INV-2026-0419");
  assert.equal(raw.payee?.toLowerCase(), PAYEE);
  assert.equal(raw.currency, "PROS");
  assert.equal(raw.amount, "0.0040");
  assert.deepEqual(raw.items?.map((i) => i.amount), [0.003, 0.001]);
});

test("pdf invoice: text comes out of the deflated content stream", () => {
  const raw = parseInvoice("samples/03-audit.pdf");
  assert.equal(raw.format, "pdf");
  assert.equal(raw.reference, "INV-2026-0118");
  assert.equal(raw.payee?.toLowerCase(), PAYEE);
  assert.equal(raw.amount, "0.15");
  assert.equal(raw.currency, "USDC");
});

test("png with a QR code: EIP-681 token transfer, units turned into USDC", () => {
  const raw = parseInvoice("samples/04-checkout-qr.png");
  assert.equal(raw.format, "qr");
  assert.equal(raw.chainId, 1672);
  assert.equal(raw.currency, "USDC");
  assert.equal(raw.payee?.toLowerCase(), PAYEE);
  assert.equal(raw.amount, "0.1");
  assert.equal(raw.reference, "INV-2026-QR-0042");
});

test("payment links: native value, scientific notation, unknown token kept as address", () => {
  const native = parsePaymentLink(`ethereum:${PAYEE}@1672?value=2.5e15&ref=X-1`);
  assert.equal(native?.currency, "PROS");
  assert.equal(native?.amount, "0.0025");
  const odd = parsePaymentLink(`ethereum:0x1111111111111111111111111111111111111111@1672/transfer?address=${PAYEE}&uint256=5`);
  assert.equal(odd?.currency, "0x1111111111111111111111111111111111111111");
  assert.equal(exactInteger("1.5e0"), undefined, "1.5 is not an integer amount");
  assert.equal(exactInteger("2.50e1"), 25n);
});

test("pasted text and pasted links work without a file", () => {
  assert.equal(parseInvoice(`Invoice #: A-1\nPay to: ${PAYEE}\nTotal: 1 USDC`).reference, "A-1");
  assert.equal(parseInvoice(`ethereum:${PAYEE}@1672?value=1`).format, "qr");
});
