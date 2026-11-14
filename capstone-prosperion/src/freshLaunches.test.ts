import { test } from "node:test";
import assert from "node:assert/strict";
import type { Address } from "viem";
import { launchRefresher } from "./freshLaunches.js";
import { openStore, type Launch } from "./store.js";
import type { MarketCheck } from "./market.js";

const OPEN = "0xE2Cb631588789954D275407e66C20bA6497CfF2A" as Address;
const DONE = "0x8DAA60552dbB856A4EEBC271Ff6783F42e63A26E" as Address;
const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672" as Address;

const checkAt = (market: Address, block: bigint, over: Partial<MarketCheck> = {}): MarketCheck => ({
  market, block, genuine: true, vault: null, pToken: null, phase: 0, reserveBefore: 0n, implNow: IMPL,
  amountIn: 10n ** 18n, quoteOut: 1n, ...over,
});
const launch = (market: Address, block: bigint, checks: MarketCheck | null): Launch => ({
  market, vault: "0x9c376a4D346dC81068b19D25D73B1a88CB9a9222", pToken: "0xefE6F8d798cc8144AFbc4da56Ff1D411955a1E54", block, tx: "0xabc", checks,
});

function setup() {
  const store = openStore(":memory:");
  store.saveLaunch(launch(OPEN, 100n, checkAt(OPEN, 101n)));
  store.saveLaunch(launch(DONE, 90n, checkAt(DONE, 91n, { phase: 2, reserveBefore: 5n })));
  const asked: Address[] = [];
  let t = 1_000;
  let reserve = 17_622_000_000_000_000n;
  const check = async (m: Address, amountIn: bigint) => { asked.push(m); return checkAt(m, 500n, { reserveBefore: reserve, amountIn }); };
  const fresh = launchRefresher(store, check, () => t);
  return { store, asked, fresh, tick: (s: number) => { t += s; }, setReserve: (r: bigint) => { reserve = r; } };
}

test("a launch still on the curve is checked again, so 'nobody in yet' cannot outlive the first buyer", async () => {
  const s = setup();
  const list = await s.fresh(30);
  const open = list.find((l) => l.market === OPEN)!;
  assert.equal(BigInt(open.checks!.reserveBefore), 17_622_000_000_000_000n);
  assert.equal(BigInt(open.checks!.block), 500n);
  // and it sticks: the agent's recent_launches reads the same rows
  assert.equal(BigInt(s.store.listLaunches(30).find((l) => l.market === OPEN)!.checks!.reserveBefore), 17_622_000_000_000_000n);
});

test("a market that already left the curve is not asked again: it cannot come back", async () => {
  const s = setup();
  await s.fresh(30);
  assert.deepEqual(s.asked, [OPEN]);
});

test("visitors within fifteen seconds share one check instead of each hitting the chain", async () => {
  const s = setup();
  await Promise.all([s.fresh(30), s.fresh(30)]);
  s.tick(10);
  await s.fresh(30);
  assert.equal(s.asked.length, 1);
  s.tick(10);
  s.setReserve(2n);
  const list = await s.fresh(30);
  assert.equal(s.asked.length, 2);
  assert.equal(BigInt(list.find((l) => l.market === OPEN)!.checks!.reserveBefore), 2n);
});

test("when the chain does not answer, the list still loads with the last check and its block", async () => {
  const store = openStore(":memory:");
  store.saveLaunch(launch(OPEN, 100n, checkAt(OPEN, 101n)));
  const fresh = launchRefresher(store, async () => { throw new Error("rpc down"); }, () => 1_000);
  const list = await fresh(30);
  assert.equal(BigInt(list[0].checks!.block), 101n);
});
