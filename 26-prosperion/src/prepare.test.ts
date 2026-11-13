import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { prepareBuy } from "./prepare.js";
import { openStore } from "./store.js";
import type { MarketCheck } from "./market.js";

const MARKET = "0x94228EB493173E75a12e76E667bfe9b0939aae64";
const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672";
const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";

const check = (over: Partial<MarketCheck> = {}) => async (): Promise<MarketCheck> => ({
  market: MARKET, block: 100n, genuine: true, vault: "0x251a68B711EA3967B434EefCA49D43cD133Ef3ee",
  pToken: "0x14C150c0D60006d0CDdDcA860bA7C50F180baf81", phase: 0, reserveBefore: 0n, implNow: IMPL,
  amountIn: 10n ** 17n, quoteOut: 1_000_000n, ...over,
});

test("a fresh market gets a sign link that holds the visitor to being first", async () => {
  const store = openStore(":memory:");
  const r = await prepareBuy(store, check(), { market: MARKET, owner: ME, amountWei: parseEther("0.5"), source: "agent" });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.match(r.url, /\/sign\/\?r=[A-Za-z0-9_-]+$/);
  const saved = store.getRequest(r.id)!;
  assert.equal(saved.kind, "buy");
  assert.equal(saved.createdBlock, 100n);
  assert.deepEqual(saved.params, {
    market: MARKET, owner: ME, amountWei: parseEther("0.5").toString(), minOutBps: 9800,
    maxReserveBeforeWei: "0", acceptedImpl: IMPL, source: "agent",
  });
});

test("with someone already in, the limit is what is in the curve now, so nobody else can slip in first", async () => {
  const store = openStore(":memory:");
  const r = await prepareBuy(store, check({ reserveBefore: parseEther("3") }), { market: MARKET, owner: ME, amountWei: parseEther("1"), source: "page" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(store.getRequest(r.id)!.params.maxReserveBeforeWei, parseEther("3").toString());
});

test("a graduated market is refused in words and nothing is saved", async () => {
  const store = openStore(":memory:");
  const r = await prepareBuy(store, check({ phase: 2 }), { market: MARKET, owner: ME, amountWei: parseEther("1"), source: "agent" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.refusal, /left the curve/);
});

test("a market Prosper's factory does not list is refused", async () => {
  const store = openStore(":memory:");
  const r = await prepareBuy(store, check({ genuine: false, phase: -1 }), { market: MARKET, owner: ME, amountWei: parseEther("1"), source: "agent" });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.refusal, /not a Prosper market/i);
});

test("a stated in-curve limit below what is already in is refused", async () => {
  const store = openStore(":memory:");
  const r = await prepareBuy(store, check({ reserveBefore: parseEther("3") }), {
    market: MARKET, owner: ME, amountWei: parseEther("1"), maxReserveBeforeWei: parseEther("1"), source: "agent",
  });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.refusal, /no longer first/i);
});

test("zero and absurd amounts are refused before the chain is read", async () => {
  const store = openStore(":memory:");
  let reads = 0;
  const counting = async () => { reads++; return check()(); };
  for (const amountWei of [0n, parseEther("1001")]) {
    const r = await prepareBuy(store, counting, { market: MARKET, owner: ME, amountWei, source: "agent" });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.refusal, /between/);
  }
  assert.equal(reads, 0);
});

test("with limits on the gate, an amount above them is refused before a link is made", async () => {
  const store = openStore(":memory:");
  const gate = {
    readLimits: async () => ({ maxPerBuy: parseEther("0.1"), maxPerDay: parseEther("0.3"), maxReserveBefore: 0n, acceptedMarketImpl: IMPL as `0x${string}` }),
    spentToday: async () => 0n,
  };
  const r = await prepareBuy(store, check(), { market: MARKET, owner: ME, amountWei: parseEther("10"), source: "agent" }, gate);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.refusal, /above your limit of 0\.1 PROS per buy/);
  const fits = await prepareBuy(store, check(), { market: MARKET, owner: ME, amountWei: parseEther("0.1"), source: "agent" }, gate);
  assert.equal(fits.ok, true);
});
