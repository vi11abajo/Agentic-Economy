// check() replayed from mainnet tapes (node test/record-tapes.mjs airdrop|buys|airdrop-short|buys-short).
// Balances are "what if" numbers so the cases don't depend on what some real wallet holds today.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromTape, type Chain, type Overrides } from "./chain.js";
import { check, type CheckReport } from "./check.js";
import { renderCheck } from "./report.js";
import { SIM_KEY, nonceFor, revivePlan } from "./testkit.js";

async function replay(scene: string): Promise<CheckReport> {
  const saved = JSON.parse(readFileSync(new URL(`../test/tapes/${scene}.json`, import.meta.url), "utf8"));
  const revived = revivePlan(saved);
  return check(fromTape(saved.tape), revived.plan, { now: revived.now, simKey: SIM_KEY, nonceFor, whatIf: revived.whatIf });
}

describe("check: airdrop to ten wallets", () => {
  it("pays all ten, leaves nothing in Multicall3, and admits the gas is higher", async () => {
    const r = await replay("airdrop");
    assert.equal(r.results.length, 10);
    for (const x of r.results) {
      assert.equal(x.ok, true, x.reason);
      assert.equal(x.got?.amount, 10n);
      assert.equal(x.got?.symbol, "USDC");
    }
    assert.deepEqual(r.leftovers, []);
    assert.equal(r.oneByOne.txs, 10);
    assert.ok(r.batch.gas !== null && r.batch.gas > r.oneByOne.gas, "an airdrop by signatures costs more gas than plain transfers");
    assert.equal(r.sendable, true);
  });

  it("when the money runs out, the late payments fail and the others still go", async () => {
    const r = await replay("airdrop-short");
    const failed = r.results.filter((x) => !x.ok);
    assert.ok(failed.length > 0 && failed.length < r.results.length);
    assert.ok(failed.every((x) => /exceeds balance/.test(x.reason ?? "")), failed.map((f) => f.reason).join("; "));
    assert.ok(r.results.slice(0, r.results.length - failed.length).every((x) => x.ok), "the first payments fit in the balance");
    assert.equal(r.sendable, false);
  });
});

describe("check: the throwaway signer", () => {
  it("is simulated as a plain wallet, whatever sits at its address on chain", async () => {
    // A well-known test key's address on Pharos has been delegated through EIP-7702; USDC then checks the
    // signature the contract way and says "invalid signature". The simulation must wipe the signer's code.
    const seen: Overrides[] = [];
    const chain = {
      balance: async () => 0n,
      call: async (_tx: unknown, o?: Overrides) => {
        if (o) seen.push(o);
        return { ok: false, revertData: "0x", message: "stop here" };
      },
    } as unknown as Chain;
    const plan = { wallet: getAddress("0x4da5c63c10b505e638b5bf5226df15a1c8cb804a"), actions: [{ kind: "send_usdc" as const, to: getAddress("0x64f26258f839af800b2ac9e3ead0ae8e7c2e0f7c"), amount: "1" }] };
    await check(chain, plan, { now: 1n, simKey: SIM_KEY, nonceFor, whatIf: { usdc: 5n } }).catch(() => {});
    const signer = privateKeyToAccount(SIM_KEY).address.toLowerCase();
    assert.ok(seen.length > 0);
    assert.equal(seen[0][signer as `0x${string}`]?.code, "0x");
  });
});

describe("check: three Prosper buys", () => {
  it("buys all three straight into the wallet and beats one-by-one on gas", async () => {
    const r = await replay("buys");
    assert.deepEqual(r.results.map((x) => [x.ok, x.got?.symbol]), [[true, "pTACO"], [true, "pCARR"], [true, "pMusk"]]);
    assert.ok(r.results.every((x) => (x.got?.amount ?? 0n) > 0n));
    assert.deepEqual(r.leftovers, []);
    assert.equal(r.oneByOne.txs, 7);
    assert.ok(r.batch.gas !== null && r.batch.gas < r.oneByOne.gas);
    assert.ok(r.warnings.some((w) => /pMusk/.test(w) && /curve/.test(w)));
    assert.equal(r.sendable, true);
  });

  it("says so when the wallet doesn't have the PROS", async () => {
    const r = await replay("buys-short");
    assert.equal(r.sendable, false);
    assert.ok(r.refusals.some((x) => /not enough PROS/.test(x)), r.refusals.join("; "));
  });

  it("prints the comparison in plain words", async () => {
    const text = renderCheck(await replay("buys"));
    assert.match(text, /1 transaction instead of 7/);
    assert.match(text, /-\d+\.\d\d%/);
    assert.match(text, /ready to send/);
  });
});
