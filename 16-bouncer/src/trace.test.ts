import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxUint256, type Address, type Hex } from "viem";
import type { Frame } from "./chain.js";
import { DEAD, HIDDEN_HOP, PMUSK_MARKET, PROSPER_ROUTER, USDC, WALLET, recorded } from "./testkit.js";
import { readTrace } from "./trace.js";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const word = (a: string) => `0x${a.slice(2).padStart(64, "0")}` as Hex;
const amount = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
const OTHER = "0x1111111111111111111111111111111111111111" as Address;
const TOKEN = "0x2222222222222222222222222222222222222222" as Address;

describe("readTrace on real mainnet traces", () => {
  it("finds the contract a pMusk buy reaches that nobody asked about", () => {
    const facts = readTrace(recorded("pmusk-buy").frame, WALLET);
    const market = facts.hops.find((h) => h.address === PMUSK_MARKET)!;
    assert.equal(market.depth, 0);
    const hidden = facts.hops.find((h) => h.address === HIDDEN_HOP)!;
    assert.equal(hidden.depth, 1);
    assert.deepEqual(hidden.path, [WALLET, PMUSK_MARKET, HIDDEN_HOP]);
    assert.equal(facts.reverted, null);
  });

  it("counts the buy's PROS once, even though Pharos repeats it on the proxy's DELEGATECALL", () => {
    assert.equal(readTrace(recorded("pmusk-buy").frame, WALLET).prosOut, 1000000000000000n);
  });

  it("sees a plain PROS send and who gets it", () => {
    const facts = readTrace(recorded("pros-send").frame, WALLET);
    assert.equal(facts.prosOut, 1000000000000000n);
    assert.deepEqual(facts.prosTo.map((p) => [p.to, p.amount]), [[DEAD, 1000000000000000n]]);
    assert.deepEqual(facts.hops.map((h) => h.address), [DEAD]);
  });

  it("spots an unlimited approval", () => {
    const facts = readTrace(recorded("usdc-approve-max").frame, WALLET);
    assert.deepEqual(facts.approvals, [{ token: USDC, spender: PROSPER_ROUTER, amount: maxUint256, kind: "erc20" }]);
  });

  it("says why a buy bigger than the wallet can't go through", () => {
    const facts = readTrace(recorded("too-big-buy").frame, WALLET);
    assert.ok(facts.reverted);
    assert.match(facts.reverted!.reason, /balance/);
  });
});

describe("readTrace on hand-made frames", () => {
  const top = (calls: Frame[], extra: Partial<Frame> = {}): Frame => ({ type: "CALL", from: WALLET, to: OTHER, value: "0x0", calls, ...extra });

  it("doesn't count a token transfer that was rolled back inside the tx", () => {
    const reverted: Frame = { type: "CALL", from: OTHER, to: TOKEN, error: "execute_revert", logs: [{ address: TOKEN, topics: [TRANSFER, word(WALLET), word(OTHER)], data: amount(5n) }] };
    const facts = readTrace(top([reverted]), WALLET);
    assert.equal(facts.tokensOut.size, 0);
    assert.equal(facts.hops.find((h) => h.address === TOKEN)?.reverted, true);
  });

  it("counts a token leaving the wallet and who receives it", () => {
    const facts = readTrace(top([], { logs: [{ address: TOKEN, topics: [TRANSFER, word(WALLET), word(OTHER)], data: amount(7n) }] }), WALLET);
    assert.equal(facts.tokensOut.get(TOKEN), 7n);
    assert.deepEqual(facts.tokenTo, [{ token: TOKEN, to: OTHER, amount: 7n }]);
  });

  it("ignores reads: a STATICCALL is not a hop", () => {
    const facts = readTrace(top([{ type: "STATICCALL", from: OTHER, to: TOKEN }]), WALLET);
    assert.deepEqual(facts.hops.map((h) => h.address), [OTHER]);
  });

  it("treats creating a contract as a hop", () => {
    const facts = readTrace(top([{ type: "CREATE2", from: OTHER, to: TOKEN }]), WALLET);
    assert.equal(facts.hops.find((h) => h.address === TOKEN)?.type, "CREATE2");
  });

  it("skips precompiles like ecrecover", () => {
    const facts = readTrace(top([{ type: "CALL", from: OTHER, to: "0x0000000000000000000000000000000000000001" }]), WALLET);
    assert.deepEqual(facts.hops.map((h) => h.address), [OTHER]);
  });

  it("sees an NFT approval and a blanket operator approval", () => {
    const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
    const FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
    const facts = readTrace(top([], { logs: [
      { address: TOKEN, topics: [APPROVAL, word(WALLET), word(OTHER), amount(9n)], data: "0x" },
      { address: TOKEN, topics: [FOR_ALL, word(WALLET), word(OTHER)], data: amount(1n) },
    ] }), WALLET);
    assert.deepEqual(facts.approvals.map((a) => [a.kind, a.spender, a.amount]), [["erc721", OTHER, "nft"], ["forall", OTHER, "all"]]);
  });
});
