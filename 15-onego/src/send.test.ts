// send() with a fake chain and a fake check: what matters here is what it refuses, what it signs, and how it
// reads the outcome. The check itself is tested on mainnet tapes in check.test.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, getAddress, parseTransaction, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Authorization, Step } from "./batch.js";
import { MULTICALL3, USDC, multicall3Abi, usdcAuthAbi } from "./book.js";
import type { Chain, Receipt } from "./chain.js";
import type { CheckReport, Built } from "./check.js";
import { cancel, send } from "./send.js";

const account = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const A = getAddress("0x64f26258f839af800b2ac9e3ead0ae8e7c2e0f7c");
const B = getAddress("0xc5f6fe56976e0a55aed6c0e08951a8a2f8980f45");
const plan = { wallet: account.address, actions: [{ kind: "send_usdc" as const, to: A, amount: "1" }, { kind: "send_usdc" as const, to: B, amount: "1" }] };
const auth = (action: number, to: typeof A, n: number): Authorization => ({ action, to, value: 1_000_000n, validBefore: 2_000_000_000n, nonce: `0x${n.toString(16).padStart(64, "0")}`, signature: "0x" });
const step = (action: number): Step => ({ action, label: `pay ${action}`, call: { target: USDC, allowFailure: true, value: 0n, callData: "0x" } });

function fakeCheck(sendable: boolean): () => Promise<CheckReport & { built: Built }> {
  return async () => ({
    wallet: account.address,
    results: plan.actions.map((a, i) => ({ action: i, label: `send 1 USDC to ${a.to}`, ok: true })),
    leftovers: [],
    batch: { txs: 1, gas: 200_000n, feePros: 0n, value: 0n },
    oneByOne: { txs: 2, gas: 150_000n, feePros: 0n },
    warnings: [],
    sendable,
    refusals: sendable ? [] : ["action 1 would fail: price moved"],
    built: { steps: [step(0), step(1)], readBacks: [], value: 0n, authorizations: [auth(0, A, 1), auth(1, B, 2)], overrides: {} },
  });
}

function fakeChain(opts: { receipt: Receipt["status"]; used: Set<string> }) {
  const sent: Hex[] = [];
  const chain = {
    gasPrice: async () => 10_000_000_000n,
    nonce: async () => 7,
    sendRaw: async (tx: Hex) => (sent.push(tx), "0xabc" as Hex),
    receipt: async () => ({ status: opts.receipt, gasUsed: 1n, blockNumber: 1n, logs: [] }),
    call: async (tx: { data: Hex }) => {
      const d = decodeFunctionData({ abi: usdcAuthAbi, data: tx.data });
      const used = d.functionName === "authorizationState" && opts.used.has(String(d.args[1]));
      return { ok: true, data: encodeFunctionResult({ abi: usdcAuthAbi, functionName: "authorizationState", result: used }) };
    },
  } as unknown as Chain;
  return { chain, sent };
}
const opts = { now: 1_800_000_000n, nonceFor: (i: number) => `0x${(i + 1).toString(16).padStart(64, "0")}` as Hex, sleep: async () => {} };

describe("send", () => {
  it("refuses a plan made for another wallet", async () => {
    const { chain, sent } = fakeChain({ receipt: "success", used: new Set() });
    const r = await send(chain, { ...plan, wallet: A }, account, { ...opts, check: fakeCheck(true) });
    assert.equal(r.status, "refused");
    assert.equal(sent.length, 0);
  });

  it("sends nothing when the fresh check fails", async () => {
    const { chain, sent } = fakeChain({ receipt: "success", used: new Set() });
    const r = await send(chain, plan, account, { ...opts, check: fakeCheck(false) });
    assert.equal(r.status, "refused");
    assert.deepEqual(r.refusals, ["action 1 would fail: price moved"]);
    assert.equal(sent.length, 0);
  });

  it("signs one Pharos transaction to Multicall3", async () => {
    const all = new Set([auth(0, A, 1).nonce, auth(1, B, 2).nonce]);
    const { chain, sent } = fakeChain({ receipt: "success", used: all });
    const r = await send(chain, plan, account, { ...opts, check: fakeCheck(true) });
    assert.equal(r.status, "sent_ok");
    assert.equal(sent.length, 1);
    const tx = parseTransaction(sent[0]);
    assert.equal(tx.chainId, 1672);
    assert.equal(tx.to?.toLowerCase(), MULTICALL3.toLowerCase());
    assert.equal(tx.nonce, 7);
    assert.equal(decodeFunctionData({ abi: multicall3Abi, data: tx.data! }).functionName, "aggregate3Value");
    assert.deepEqual(r.unusedAuthorizations, []);
  });

  it("names the payment that didn't go through and keeps its signature for cancelling", async () => {
    const { chain } = fakeChain({ receipt: "success", used: new Set([auth(0, A, 1).nonce]) });
    const r = await send(chain, plan, account, { ...opts, check: fakeCheck(true) });
    assert.deepEqual(r.results.map((x) => x.ok), [true, false]);
    assert.deepEqual(r.unusedAuthorizations.map((a) => a.to), [B]);
  });

  it("after a revert, every signature is still out there", async () => {
    const { chain } = fakeChain({ receipt: "reverted", used: new Set() });
    const r = await send(chain, plan, account, { ...opts, check: fakeCheck(true) });
    assert.equal(r.status, "reverted");
    assert.equal(r.unusedAuthorizations.length, 2);
    assert.ok(r.results.every((x) => !x.ok));
  });
});

describe("cancel", () => {
  it("voids unused signatures in one transaction, signed by the wallet", async () => {
    const { chain, sent } = fakeChain({ receipt: "success", used: new Set() });
    await cancel(chain, account, [auth(1, B, 2)], { sleep: async () => {} });
    const tx = parseTransaction(sent[0]);
    const outer = decodeFunctionData({ abi: multicall3Abi, data: tx.data! });
    const inner = (outer.args[0] as unknown as Array<{ target: string; callData: Hex }>)[0];
    assert.equal(inner.target.toLowerCase(), USDC.toLowerCase());
    const d = decodeFunctionData({ abi: usdcAuthAbi, data: inner.callData });
    assert.equal(d.functionName, "cancelAuthorization");
    assert.equal(d.args[0], account.address);
  });
});
