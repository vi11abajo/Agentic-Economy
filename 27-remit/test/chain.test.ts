import test from "node:test";
import assert from "node:assert/strict";
import type { PublicClient } from "viem";
import { parseInvoice } from "../src/parser/index.js";
import { validateInvoice } from "../src/validator.js";
import { createPaymentPlan, encodeReferenceMemo } from "../src/tx.js";
import { checkOnChain } from "../src/chain.js";

// A pretend Pharos: just enough of a viem client for the checks, with knobs for each case.
function fakeChain(o: { tokenCode?: string; balance?: bigint; gasFails?: boolean; paidInput?: string } = {}) {
  return {
    getBlockNumber: async () => 22_900_000n,
    getCode: async ({ address }: { address: string }) => (address.toLowerCase().startsWith("0xc879") ? (o.tokenCode ?? "0x60") : "0x"),
    readContract: async ({ functionName }: { functionName: string }) =>
      functionName === "symbol" ? "USDC" : functionName === "decimals" ? 6 : (o.balance ?? 5_000_000n),
    getBalance: async () => 10n ** 17n,
    estimateGas: async () => {
      if (o.gasFails) throw new Error("execution reverted: ERC20: transfer amount exceeds balance");
      return 50_000n;
    },
    getGasPrice: async () => 10_000_000_000n,
    getTransaction: async () => ({ input: o.paidInput ?? "0xa9059cbb", blockNumber: 1n, from: "0xabc" }),
    getTransactionReceipt: async () => ({ status: "success" }),
  } as unknown as PublicClient;
}

const invoice = validateInvoice(parseInvoice("samples/01-hosting.json")).invoice!;
const tx = createPaymentPlan(invoice).tx;
const payer = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const realFetch = globalThis.fetch;
const historyWith = (rows: object[]) => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: rows }))) as typeof fetch;
};
const stops = (r: { flags: { severity: string; code: string }[] }) => r.flags.filter((f) => f.severity === "FATAL").map((f) => f.code);

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("clean run: dry run passes, gas gets 20% headroom", async () => {
  historyWith([]);
  const r = await checkOnChain(fakeChain(), invoice, tx, payer);
  assert.deepEqual(stops(r), []);
  assert.equal(r.gasLimit, "0xea60");
  assert.equal(r.chain.payerHolds, "5");
});

test("token with no code, payer too poor, tx that would revert", async () => {
  historyWith([]);
  assert.deepEqual(stops(await checkOnChain(fakeChain({ tokenCode: "0x" }), invoice, tx)), ["TOKEN_NOT_ON_CHAIN"]);
  assert.deepEqual(stops(await checkOnChain(fakeChain({ balance: 1n, gasFails: true }), invoice, tx, payer)), ["NOT_ENOUGH_FUNDS"]);
  assert.deepEqual(stops(await checkOnChain(fakeChain({ gasFails: true }), invoice, tx, payer)), ["WOULD_REVERT"]);
});

test("the same reference already paid to this payee stops the plan", async () => {
  historyWith([{ transaction_hash: "0x" + "ab".repeat(32), to_address: invoice.payee, token_address: invoice.token.address }]);
  const memo = encodeReferenceMemo(invoice.reference).slice(2);
  const r = await checkOnChain(fakeChain({ paidInput: "0xa9059cbb00" + memo }), invoice, tx);
  assert.deepEqual(stops(r), ["ALREADY_PAID"]);
  assert.match(r.flags.find((f) => f.code === "ALREADY_PAID")!.proof!, /pharosscan\.xyz\/tx\/0xabab/);
});
