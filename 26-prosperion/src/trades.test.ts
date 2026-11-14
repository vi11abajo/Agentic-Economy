import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, pad, type Address, type Hex } from "viem";
import { BUY_TOPIC, SELL_TOPIC, decodeTrade, openTradeBook, TradeIndexer, type RawTradeLog } from "./trades.js";
import { openStore } from "./store.js";

const FROG = "0x8DAA60552dbB856A4EEBC271Ff6783F42e63A26E" as Address;
const ROUTER = "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5" as Address;
const W261 = "0x261a31f9bd2789B490bAdF62784D8c58151b1bD2" as Address;
const WB6D = "0xb6DB3EF6f6293F196Cb96ACb6A9CF4843d8B00Ad" as Address;
const words = (xs: bigint[]) => encodeAbiParameters(xs.map(() => ({ type: "uint256" })), xs);

// The real pFROG buy in tx 0xd73c66a5…f004 (block 22,889,592): 19 PROS in through Prosper's router.
const realBuy: RawTradeLog = {
  address: FROG, blockNumber: `0x${(22_889_592).toString(16)}`, transactionHash: "0xd73c66a5750a1656ff0ed44e09e961b08429de43e1a25c81c5cca0df5945f004", logIndex: "0x4",
  topics: [BUY_TOPIC, pad(ROUTER), pad(W261)],
  data: words([0x107ad8f556c6c0000n, 0x1050a8b5721190000n, 0x21156bfbb69c4425eefc9n, 0x2a303fe4b530000n]),
};
// The real pFROG sell in tx 0x65a1e01b…7b13: 3,933,004 pFROG back to the curve.
const realSell: RawTradeLog = {
  address: FROG, blockNumber: `0x${(22_821_912).toString(16)}`, transactionHash: "0x65a1e01bc8bdd0f75c6915af8fff7df2733ba0823d18562c9e4cad8eecd97b13", logIndex: "0x6",
  topics: [SELL_TOPIC, pad(ROUTER), pad(WB6D)],
  data: words([0x340d89350d6fcc1a114c8n, 0x19b4d5c5f48a63800n, 0x197306d5e54b9095dn, 0x41cef00f3ed2ea3n]),
};

test("a market's buy event reads as: who got the tokens, PROS paid, PROS that reached the curve, tokens, fee", () => {
  const t = decodeTrade(realBuy)!;
  assert.equal(t.kind, "buy");
  assert.equal(t.trader, W261);
  assert.equal(t.caller, ROUTER);
  assert.equal(t.prosGross, 19n * 10n ** 18n);
  assert.equal(t.prosNet, 18_810_000_000_000_000_000n);
  assert.equal(t.fee, 190_000_000_000_000_000n);
  assert.equal(t.tokens, 0x21156bfbb69c4425eefc9n);
  assert.equal(t.block, 22_889_592n);
});

test("a sell event reads as: who got the PROS, tokens in, PROS before and after the fee", () => {
  const t = decodeTrade(realSell)!;
  assert.equal(t.kind, "sell");
  assert.equal(t.trader, WB6D);
  assert.equal(t.tokens, 0x340d89350d6fcc1a114c8n);
  assert.equal(t.prosGross - t.prosNet, t.fee, "the fee is exactly the gap between gross and net");
});

test("anything else from the market is not a trade", () => {
  assert.equal(decodeTrade({ ...realBuy, topics: ["0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925" as Hex] }), null);
});

function fakeChain(logs: RawTradeLog[], head: bigint) {
  const asked: [bigint, bigint][] = [];
  return {
    asked,
    deps: {
      head: async () => head,
      markets: async () => [FROG],
      getLogs: async (_m: Address[], from: bigint, to: bigint) => {
        asked.push([from, to]);
        return logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to);
      },
      startBlock: async () => 22_820_000n,
    },
  };
}

test("the indexer walks the chain in 1000-block windows from the first launch to the head, once", async () => {
  const book = openTradeBook(openStore(":memory:").db);
  const c = fakeChain([realSell, realBuy], 22_890_100n);
  const ix = new TradeIndexer(book, c.deps);
  while (await ix.step()) { /* until caught up */ }
  assert.deepEqual(c.asked[0], [22_820_000n, 22_820_999n]);
  assert.ok(c.asked.every(([a, z]) => z - a <= 999n));
  assert.equal(c.asked.at(-1)![1], 22_890_100n);
  assert.deepEqual(book.coverage(), { from: 22_820_000n, to: 22_890_100n });
  // a restart picks up where it stopped and stores nothing twice
  const again = new TradeIndexer(book, c.deps);
  assert.equal(await again.step(), false);
  assert.equal(book.trades(FROG, 50).length, 2);
});

test("only trades near the head reach the bot; the backfill stays history", async () => {
  const book = openTradeBook(openStore(":memory:").db);
  const c = fakeChain([realSell, realBuy], 22_890_100n);
  const told: bigint[] = [];
  const ix = new TradeIndexer(book, { ...c.deps, onTrades: async (ts) => { told.push(...ts.map((t) => t.block)); } });
  while (await ix.step()) { /* until caught up */ }
  assert.equal(book.trades(FROG, 50).length, 2, "both are indexed");
  assert.deepEqual(told, [BigInt(realBuy.blockNumber)], "only the one within the last 600 blocks is news");
});

test("a market's story: buyers, sellers, PROS in and out, and who still holds from curve trades", async () => {
  const book = openTradeBook(openStore(":memory:").db);
  const buyB6d = { ...realBuy, blockNumber: `0x${(22_814_291).toString(16)}`, transactionHash: "0x29d2" as Hex, topics: [BUY_TOPIC, pad(ROUTER), pad(WB6D)] as Hex[],
    data: words([29_936_814_431_419_801_600n, 29_637_446_287_105_603_584n, 0x340d89350d6fcc1a114c8n, 299_368_144_314_198_016n]) };
  book.save([buyB6d, realSell, realBuy].map((l) => decodeTrade(l)!));
  const s = book.summary(FROG);
  assert.equal(s.buys, 2);
  assert.equal(s.sells, 1);
  assert.equal(s.buyers, 2);
  assert.equal(s.prosInGross, 29_936_814_431_419_801_600n + 19n * 10n ** 18n);
  assert.deepEqual(s.holdersFromCurve.map((h) => h.wallet), [W261], "the wallet that sold everything back holds nothing");
  assert.deepEqual(s.roundTrips, [WB6D]);
  const last = book.trades(FROG, 2);
  assert.equal(last[0].kind, "buy", "newest first");
  assert.equal(last[0].trader, W261);
});
