import test from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, fromHex, parseAbi, slice } from "viem";
import { parseInvoice } from "../src/parser/index.js";
import { validateInvoice } from "../src/validator.js";
import { createPaymentPlan } from "../src/tx.js";
import { CANONICAL_TOKENS } from "../src/tokens.js";

const planOf = (f: string) => createPaymentPlan(validateInvoice(parseInvoice(f)).invoice!);

test("PROS: value carries the amount, the input is the reference", () => {
  const p = planOf("samples/02-freelance.md");
  assert.equal(BigInt(p.tx.value), 4_000_000_000_000_000n);
  assert.equal(fromHex(p.tx.data, "string"), "INV:INV-2026-0419");
});

test("USDC: transfer(to, amount) decodes cleanly, reference rides after the arguments", () => {
  const p = planOf("samples/01-hosting.json");
  assert.equal(p.tx.to.toLowerCase(), CANONICAL_TOKENS.USDC.address);
  const call = decodeFunctionData({ abi: parseAbi(["function transfer(address,uint256)"]), data: slice(p.tx.data, 0, 68) });
  assert.equal(call.args[1], 300000n);
  assert.equal(fromHex(slice(p.tx.data, 68), "string"), "INV:INV-2026-1107");
});

test("WPROS points at the contract that exists on mainnet", () => {
  assert.equal(CANONICAL_TOKENS.WPROS.address, "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0");
});
