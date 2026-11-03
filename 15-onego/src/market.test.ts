// Quotes replayed from a tape of mainnet answers (test/record-tapes.mjs quotes). The swap probe on the tape is
// the real pair saying yes to our quote and no to 0.1% more.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { parseEther } from "viem";
import { fromTape } from "./chain.js";
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
