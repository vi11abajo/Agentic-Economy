import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMarket } from "./market.js";

const PBOT_MARKET = "0x94228eb493173e75a12e76e667bfe9b0939aae64";
const ONE_PROS = 10n ** 18n;

test("pBOT's market is a real Prosper market and quotes a buy", async () => {
  const m = await checkMarket(PBOT_MARKET, ONE_PROS);
  assert.equal(m.genuine, true);
  assert.equal(m.vault?.toLowerCase(), "0x251a68b711ea3967b434eefca49d43cd133ef3ee");
  assert.equal(m.pToken?.toLowerCase(), "0x14c150c0d60006d0cdddca860ba7c50f180baf81");
  assert.ok(m.quoteOut > 0n || m.phase !== 0, "an on-curve market must quote");
  assert.match(m.implNow, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(m.block > 0n);
});

test("USDC pretending to be a market is not genuine, and nothing throws", async () => {
  const m = await checkMarket("0xC879C018dB60520F4355C26eD1a6D572cdAC1815", ONE_PROS);
  assert.equal(m.genuine, false);
  assert.equal(m.quoteOut, 0n);
});

test("a plain wallet is not a market either", async () => {
  const m = await checkMarket("0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb", ONE_PROS);
  assert.equal(m.genuine, false);
});
