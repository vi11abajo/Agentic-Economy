// Quotes replayed from a tape of mainnet answers (test/record-tapes.mjs quotes). The swap probe on the tape is
// the real pair saying yes to our quote and no to 0.1% more.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { decodeFunctionData, encodeFunctionResult, parseEther } from "viem";
import { erc20Abi, marketAbi } from "./book.js";
import { fromTape, type Chain } from "./chain.js";
import { quoteCurve, quotePool, resolveVenue } from "./market.js";
import { probeSwap } from "./testkit.js";

const { tape } = JSON.parse(readFileSync(new URL("../test/tapes/quotes.json", import.meta.url), "utf8"));
const chain = fromTape(tape);
const FIVE = parseEther("5");

describe("resolveVenue", () => {
  it("finds pTACO's pool", async () => {
    const v = await resolveVenue(chain, "pTACO");
    assert.equal(v.kind, "pool");
    assert.equal(v.kind === "pool" && v.pair.toLowerCase(), "0xaf2b77d76c6256826c2b650aa6d0bbf297a0e7b8");
    assert.equal(v.kind === "pool" && v.wprosIs0, false);
  });

  it("knows pMusk is still on a curve that failed", async () => {
    const v = await resolveVenue(chain, "pMusk");
    assert.equal(v.kind, "curve");
    assert.equal(v.kind === "curve" && v.phase, 3);
    assert.equal(v.kind === "curve" && v.failed, true);
  });

  it("says so when it doesn't know a token", async () => {
    await assert.rejects(resolveVenue(chain, "pNOPE"), /pNOPE/);
  });
});

describe("quotes", () => {
  it("quotes exactly what the pair accepts, and 0.1% more is refused", async () => {
    const v = await resolveVenue(chain, "pTACO");
    assert.equal(v.kind, "pool");
    if (v.kind !== "pool") return;
    const out = quotePool(v, FIVE);
    assert.equal((await probeSwap(chain, v, FIVE, out)).ok, true);
    assert.equal((await probeSwap(chain, v, FIVE, (out * 1001n) / 1000n)).ok, false);
  });

  it("takes the curve's own quote", async () => {
    const v = await resolveVenue(chain, "pMusk");
    if (v.kind !== "curve") return assert.fail("pMusk should be a curve");
    const q = await quoteCurve(chain, v, FIVE);
    assert.equal(q.usedGross, FIVE);
    assert.ok(q.out > 0n);
  });
});

describe("a market given in the plan", () => {
  it("must sell the token the plan asked for", async () => {
    const other = "0x52ACdEb49056518578c7af788aE2C367132E2DB5";
    // A made-up market that says it sells pTACO while the plan wants pMusk's address.
    const fake = {
      call: async (tx: { to: string; data: `0x${string}` }) => {
        const { functionName } = decodeFunctionData({ abi: [...marketAbi, ...erc20Abi], data: tx.data });
        const result = functionName === "pToken" ? other : functionName === "phase" ? 1 : functionName === "endsAt" ? 0n : "TACO";
        return { ok: true, data: encodeFunctionResult({ abi: [...marketAbi, ...erc20Abi], functionName, result } as never) };
      },
    } as unknown as Chain;
    await assert.rejects(resolveVenue(fake, "0xE318ac4113324841265d270Dc2393f1Bf742A7f8", "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f"), /sells .*not/);
  });
});
