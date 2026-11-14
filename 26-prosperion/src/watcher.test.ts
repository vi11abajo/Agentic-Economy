import { test } from "node:test";
import assert from "node:assert/strict";
import { LaunchWatcher } from "./watcher.js";
import { openStore, type Launch } from "./store.js";
import type { MarketCheck } from "./market.js";

// The real MarketCreated log for pBOT, block 22656349, tx 0x5129…0cd9.
const PBOT_LOG = {
  address: "0xefdbb0ea7647b0e21aef7a3b7a5d6a632c3116c8",
  blockNumber: "0x159b55d",
  data: "0x00000000000000000000000094228eb493173e75a12e76e667bfe9b0939aae64000000000000000000000000997ef37a63010df7b3e1ba939898de2e6d9be7b5",
  topics: [
    "0x6d679d9dcb91cccb2f253f24f8f9b53871eac50c475cb8335cfdd93a32212865",
    "0x000000000000000000000000251a68b711ea3967b434eefca49d43cd133ef3ee",
    "0x2f02516b820bf2ddcf66af54aaa31e2e0433a1c086a1ea8dfdcdae812af6372e",
    "0x00000000000000000000000014c150c0d60006d0cdddca860ba7c50f180baf81",
  ],
  transactionHash: "0x5129a417d87f431c35e6c92f0ae849a88e91d13ee80fc05382b3bbc4e36a0cd9",
};

const freshCheck = (market: string): MarketCheck => ({
  market: market as `0x${string}`, block: 22656349n, genuine: true, vault: "0x251a68B711EA3967B434EefCA49D43cD133Ef3ee",
  pToken: "0x14C150c0D60006d0CDdDcA860bA7C50F180baf81", phase: 0, reserveBefore: 0n,
  implNow: "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672", amountIn: 10n ** 18n, quoteOut: 5n * 10n ** 22n,
});

test("a MarketCreated log becomes a checked launch", async () => {
  const seen: Launch[] = [];
  const w = new LaunchWatcher({
    head: async () => 22656350n,
    logs: async () => [PBOT_LOG],
    check: async (m: string) => freshCheck(m),
    startBlock: 22656348n,
  });
  w.on("launch", (l: Launch) => seen.push(l));
  await w.tick();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].market, "0x94228EB493173E75a12e76E667bfe9b0939aae64");
  assert.equal(seen[0].pToken, "0x14C150c0D60006d0CDdDcA860bA7C50F180baf81");
  assert.equal(seen[0].block, 22656349n);
  assert.equal(seen[0].checks?.genuine, true);
  await w.tick(); // nothing new, nothing emitted twice
  assert.equal(seen.length, 1);
});
