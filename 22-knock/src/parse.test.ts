import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePayment, type Intent, type Question } from "./parse.js";

const A = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const B = "0x000000000000000000000000000000000000dEaD";

function intent(text: string, answers?: string[]): Intent {
  const r = parsePayment(text, answers);
  assert.ok("intent" in r, `expected an intent, got questions: ${JSON.stringify(r)}`);
  return r.intent;
}
function asks(text: string, answers?: string[]): Question[] {
  const r = parsePayment(text, answers);
  assert.ok("questions" in r, `expected questions, got ${JSON.stringify(r)}`);
  return r.questions;
}

test("the plain case: amount, token, address", () => {
  assert.deepEqual(intent(`send 100 USDC to ${A}`), { amount: "100", token: "USDC", recipient: A, recipientKind: "address" });
});

test("a name and a lowercase token in a different word order", () => {
  const i = intent("pay alice.eth 0.5 usdc");
  assert.equal(i.amount, "0.5");
  assert.equal(i.token, "USDC");
  assert.equal(i.recipient, "alice.eth");
  assert.equal(i.recipientKind, "name");
});

test("1.5k means fifteen hundred", () => {
  assert.equal(intent(`send 1.5k PROS to ${B}`).amount, "1500");
});

test("1,250.50 has both separators, so it is not ambiguous", () => {
  assert.equal(intent(`send 1,250.50 USDC to ${B}`).amount, "1250.50");
});

test("1,000 and 1.000 are asked, never decided", () => {
  assert.equal(asks(`send 1,000 USDC to ${B}`)[0].field, "amount");
  assert.equal(asks(`send 1.000 USDC to ${B}`)[0].field, "amount");
});

test("dollars are not a token: it asks, and mentions USDC", () => {
  for (const t of [`send $5 to ${B}`, `send 5 dollars to ${B}`]) {
    const q = asks(t);
    assert.equal(q[0].field, "token");
    assert.match(q[0].ask, /USDC/);
  }
});

test("a missing token or a missing amount is a question", () => {
  assert.equal(asks(`send 5 to ${B}`)[0].field, "token");
  assert.equal(asks(`send USDC to ${B}`)[0].field, "amount");
  assert.equal(asks("send 5 USDC")[0].field, "recipient");
});

test("all / everything is asked, not computed", () => {
  assert.equal(asks(`send all my USDC to ${B}`)[0].field, "amount");
});

test("paying yourself", () => {
  for (const t of ["send 0.01 USDC to myself", "send 0.01 USDC to me", "move 0.01 usdc to my wallet"]) {
    const i = intent(t);
    assert.equal(i.recipientKind, "self");
    assert.equal(i.amount, "0.01");
  }
});

test("two payments in one sentence: asks to split", () => {
  assert.equal(asks(`send 1 USDC to ${A} and 2 USDC to ${B}`)[0].field, "split");
});

test("a short address is a question, not a guess", () => {
  assert.equal(asks("send 1 USDC to 0x4644...D3Bb")[0].field, "recipient");
});

test("answers fill the gap they were asked for", () => {
  assert.equal(intent(`send 5 to ${B}`, ["USDC"]).token, "USDC");
  assert.equal(intent(`send 1,000 USDC to ${B}`, ["1000"]).amount, "1000");
  assert.equal(intent(`send $5 to ${B}`, ["USDC"]).token, "USDC");
  assert.equal(intent("send 5 USDC", ["alice.eth"]).recipient, "alice.eth");
});

test("a token given by its contract address", () => {
  const i = intent(`send 3 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 to ${B}`);
  assert.equal(i.token, "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0");
  assert.equal(i.recipient, B);
});
