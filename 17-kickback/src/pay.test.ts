import { test } from "node:test";
import assert from "node:assert/strict";
import { pad, toHex, type Address, type Hex } from "viem";
import type { Receipt, TxInfo } from "./chain.js";
import { TRANSFER_TOPIC, USDC } from "./fakechain.js";
import { paidRight } from "./pay.js";

const ME = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb" as Address;
const WINNER = "0x00000000000000000000000000000000000000aa" as Address;
const OTHER = "0x00000000000000000000000000000000000000bb" as Address;
const HASH = `0x${"12".repeat(32)}` as Hex;

const usdcReceipt = (to: Address, amount: bigint, status: Receipt["status"] = "success"): Receipt => ({
  status,
  blockNumber: 1n,
  from: ME,
  to: USDC,
  logs: [{ address: USDC, topics: [TRANSFER_TOPIC, pad(ME), pad(to)], data: pad(toHex(amount)), blockNumber: 1n, logIndex: 0, transactionHash: HASH }],
});
const usdcTx: TxInfo = { hash: HASH, from: ME, to: USDC, value: 0n, input: "0x", blockNumber: 1n };
const want = { token: "USDC" as const, from: ME, to: WINNER, amountRaw: 10n };

test("paidRight accepts the right USDC transfer", () => {
  assert.equal(paidRight(usdcReceipt(WINNER, 10n), want, usdcTx), true);
});

test("paidRight rejects a wrong amount, a wrong recipient, a reverted tx", () => {
  assert.equal(paidRight(usdcReceipt(WINNER, 9n), want, usdcTx), false);
  assert.equal(paidRight(usdcReceipt(OTHER, 10n), want, usdcTx), false);
  assert.equal(paidRight(usdcReceipt(WINNER, 10n, "reverted"), want, usdcTx), false);
});

test("paidRight checks PROS by the tx value and recipient", () => {
  const r: Receipt = { status: "success", blockNumber: 1n, from: ME, to: WINNER, logs: [] };
  const pros = { ...want, token: "PROS" as const, amountRaw: 10n ** 13n };
  assert.equal(paidRight(r, pros, { ...usdcTx, to: WINNER, value: 10n ** 13n }), true);
  assert.equal(paidRight(r, pros, { ...usdcTx, to: WINNER, value: 1n }), false);
  assert.equal(paidRight(r, pros, { ...usdcTx, to: OTHER, value: 10n ** 13n }), false);
});
