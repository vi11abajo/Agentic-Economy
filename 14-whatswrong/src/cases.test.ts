// Nine real failed transactions from Pharos mainnet (Prosper, Faroswap, Harbor's Morpho vaults), replayed from
// tapes recorded by test/record-tapes.mjs. Every number below is what the chain actually answered.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { performAutopsy, type TokenAmount } from "./autopsy.js";
import { proveTheFix } from "./remedy.js";
import { fromTape } from "./witness.js";

async function investigate(name: string) {
  const { hash, tape } = JSON.parse(readFileSync(new URL(`../test/tapes/${name}.json`, import.meta.url), "utf8"));
  const witness = fromTape(tape);
  const autopsy = await performAutopsy(witness, hash);
  return { autopsy, remedy: await proveTheFix(witness, autopsy) };
}

describe("Prosper", () => {
  it("a buy that hit its own slippage guard", async () => {
    const { autopsy, remedy } = await investigate("prosper-slippage");
    assert.equal(autopsy.kind, "slippage");
    assert.equal(autopsy.said.name, "Slippage");
    assert.ok(remedy.notes.some((n) => /call layout isn't public/.test(n)), "no fake fix for a contract we can't rebuild");
  });

  it("ran out of gas, and 8x the old limit was enough at that block", async () => {
    const { autopsy, remedy } = await investigate("prosper-out-of-gas");
    assert.equal(autopsy.kind, "out_of_gas");
    assert.equal(autopsy.gasLimit, 55_622n);
    assert.equal(remedy.check?.passes, true);
    assert.equal(remedy.check?.numbers?.enoughWas, 444_976n);
  });

  it("a sale repeated after the first one went through: no approval left, nothing left to sell", async () => {
    const { autopsy, remedy } = await investigate("prosper-no-allowance");
    assert.equal(autopsy.kind, "allowance");
    assert.equal(autopsy.facts.alsoShort, "balance");
    const moved = autopsy.facts.alreadyMoved as { block: number; blocksEarlier: number };
    assert.equal(moved.block, 21_392_097);
    assert.equal(moved.blocksEarlier, 13);
    assert.equal(remedy.check?.passes, false);
    assert.equal(remedy.check?.nextProblem?.name, "ERC20InsufficientBalance", "the approve alone wouldn't have saved it");
  });
});

describe("Faroswap", () => {
  it("too little received: today the very same minimum is met, only the deadline needs refreshing", async () => {
    const { autopsy, remedy } = await investigate("faroswap-too-little");
    assert.equal(autopsy.kind, "slippage");
    assert.equal(autopsy.said.message, "Too little received");
    assert.equal(remedy.check?.passes, true);
    assert.match(remedy.check?.tried ?? "", /only the deadline/);
    assert.equal(remedy.nowSays?.message, "Transaction too old", "a plain retry today fails only on the old deadline");
  });

  it("fine one block earlier, killed by the sender's own swap just before it in the same block", async () => {
    const { autopsy, remedy } = await investigate("faroswap-same-block");
    assert.equal(autopsy.kind, "same_block");
    assert.equal(remedy.check?.passes, true, "with a fresh deadline and the same minimum it goes through today");
    assert.deepEqual(autopsy.neighbours?.map((n) => [n.index, n.sameSender]), [[1, true]]);
  });

  it("STF: the wallet didn't hold the 100 WPROS it tried to swap", async () => {
    const { autopsy } = await investigate("faroswap-stf");
    assert.equal(autopsy.kind, "balance");
    assert.equal((autopsy.facts.needed as TokenAmount).pretty, "100 WPROS");
  });

  it("expired deadline, and the same swap with a fresh one goes through", async () => {
    const { autopsy, remedy } = await investigate("faroswap-too-old");
    assert.equal(autopsy.kind, "deadline");
    assert.equal(remedy.check?.passes, true);
    assert.ok(Number(remedy.check?.numbers?.oldDeadline) < Number(autopsy.facts.blockTime), "the deadline was already behind the block's clock");
  });
});

describe("Harbor (Morpho vaults)", () => {
  it("a withdrawal the vault couldn't pay: 47 cents short of idle USDC", async () => {
    const { autopsy, remedy } = await investigate("harbor-vault-dry");
    assert.equal(autopsy.kind, "vault_liquidity");
    const wanted = autopsy.facts.wanted as TokenAmount;
    const cash = autopsy.facts.cash as TokenAmount;
    assert.equal(wanted.raw - cash.raw, 466_306n);
    assert.equal(remedy.check?.how, "looked up");
    assert.equal(remedy.check?.passes, false);
  });

  it("a deposit bigger than the wallet's USDC", async () => {
    const { autopsy } = await investigate("harbor-deposit-short");
    assert.equal(autopsy.kind, "balance");
    assert.equal((autopsy.facts.needed as TokenAmount).pretty, "1,197.7 USDC");
  });
});
