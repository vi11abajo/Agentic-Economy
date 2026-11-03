import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeFunctionData, getAddress, parseEther, recoverTypedDataAddress, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildBatch, sentData, type Step } from "./batch.js";
import { MULTICALL3, USDC, USDC_DOMAIN, multicall3Abi, pairAbi } from "./book.js";
import type { Venue } from "./market.js";
import type { Plan } from "./plan.js";

const signer = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const WALLET: Address = getAddress("0x4da5c63c10b505e638b5bf5226df15a1c8cb804a");
const A: Address = getAddress("0x64f26258f839af800b2ac9e3ead0ae8e7c2e0f7c");
const taco: Venue = { kind: "pool", symbol: "pTACO", token: "0x52ACdEb49056518578c7af788aE2C367132E2DB5", pair: "0xAf2b77d76C6256826c2B650aa6D0BbF297A0E7B8", wprosIs0: false, reserveIn: 1n, reserveOut: 1n };
const musk: Venue = { kind: "curve", symbol: "pMusk", token: "0xE318ac4113324841265d270Dc2393f1Bf742A7f8", market: "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f", phase: 3, endsAt: 0n, failed: true };
const plan: Plan = {
  wallet: WALLET,
  actions: [
    { kind: "buy", token: "pTACO", pros: "5" },
    { kind: "buy", token: "pMusk", pros: "5" },
    { kind: "send_usdc", to: A, amount: "0.00001" },
    { kind: "send_pros", to: A, amount: "1" },
  ],
};
const built = () =>
  buildBatch({
    plan,
    venues: new Map<number, Venue>([[0, taco], [1, musk]]),
    quotes: new Map([[0, { value: parseEther("5"), out: 579n }], [1, { value: parseEther("4.9"), out: 663n }]]),
    signer,
    now: 1_800_000_000n,
    nonceFor: (i) => `0x${(i + 1).toString(16).padStart(64, "0")}`,
  });
const of = (steps: Step[], action: number) => steps.filter((s) => s.action === action);

describe("buildBatch", () => {
  it("buys from a pool in three steps that can't fail alone, tokens straight to the wallet", async () => {
    const b = await built();
    const s = of(b.steps, 0);
    assert.equal(s.length, 3);
    assert.ok(s.every((x) => x.call.allowFailure === false));
    const swap = decodeFunctionData({ abi: pairAbi, data: s[2].call.callData });
    assert.equal(swap.functionName, "swap");
    assert.deepEqual(swap.args.slice(0, 3), [579n, 0n, WALLET]);
  });

  it("pays the curve only what it will use", async () => {
    const s = of((await built()).steps, 1);
    assert.equal(s.length, 1);
    assert.equal(s[0].call.value, parseEther("4.9"));
    assert.equal(s[0].call.allowFailure, false);
  });

  it("lets a USDC payment fail alone, signed by the signer", async () => {
    const b = await built();
    const s = of(b.steps, 2);
    assert.equal(s[0].call.allowFailure, true);
    assert.equal(s[0].call.target, USDC);
    const auth = b.authorizations[0];
    const from = await recoverTypedDataAddress({
      domain: USDC_DOMAIN,
      types: { TransferWithAuthorization: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "TransferWithAuthorization",
      message: { from: signer.address, to: A, value: 10n, validAfter: 0n, validBefore: 1_800_000_900n, nonce: auth.nonce },
      signature: auth.signature,
    });
    assert.equal(from, signer.address);
    assert.equal(auth.validBefore, 1_800_000_900n);
  });

  it("sends exactly the PROS the steps carry", async () => {
    const b = await built();
    assert.equal(b.value, parseEther("5") + parseEther("4.9") + parseEther("1"));
    assert.equal(b.value, b.steps.reduce((a, s) => a + s.call.value, 0n));
  });

  it("never approves or permits anything", async () => {
    const b = await built();
    for (const s of [...b.steps, ...b.readBacks]) assert.ok(!/^0x(095ea7b3|d505accf)/.test(s.call.callData), s.label);
  });

  it("reads back what's left in Multicall3, PROS included", async () => {
    const b = await built();
    const eth = b.readBacks.find((r) => r.call.target === MULTICALL3);
    assert.ok(eth);
    assert.equal(decodeFunctionData({ abi: multicall3Abi, data: eth.call.callData }).functionName, "getEthBalance");
    assert.ok(b.readBacks.every((r) => r.call.allowFailure && r.call.value === 0n));
  });
});

describe("sentData", () => {
  it("is what goes on chain: the actions only, no read-backs, so the gas we quote is the gas we pay", async () => {
    const b = await built();
    const calls = decodeFunctionData({ abi: multicall3Abi, data: sentData(b) }).args[0] as unknown as unknown[];
    assert.equal(calls.length, b.steps.length);
  });
});
