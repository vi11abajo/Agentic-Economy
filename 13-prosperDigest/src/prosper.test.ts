// Decoding on real chain data (test/fixtures, copied from services/prosper-monitor): the ProsperFactory
// MarketCreated log of pMusk and a buy/sell on its curve.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { BOUGHT, decodeMarketCreated, decodeTrade, MARKET_CREATED, SOLD, type Market, type RpcLog } from "./prosper.js";

export const fixture = (name: string) =>
  (JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8")) as { logs: RpcLog[] }).logs;
const [CREATED] = fixture("pmusk-market-created.json");
const [BUY, SELL] = fixture("pmusk-demo-logs.json");

export const PMUSK: Market = {
  market: "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f",
  pToken: "0xE318ac4113324841265d270Dc2393f1Bf742A7f8",
  symbol: "pMusk",
  decimals: 18,
  createdBlock: 20_372_512,
};

describe("prosper decoding", () => {
  it("decodes the real pMusk MarketCreated log", () => {
    assert.equal(CREATED.topics[0], MARKET_CREATED);
    const m = decodeMarketCreated(CREATED);
    assert.equal(m.market.toLowerCase(), PMUSK.market);
    assert.equal(m.pToken, PMUSK.pToken);
  });

  it("decodes the recorded buy and sell", () => {
    assert.deepEqual([BUY.topics[0], SELL.topics[0]], [BOUGHT, SOLD]);
    const buy = decodeTrade(BUY, PMUSK);
    const sell = decodeTrade(SELL, PMUSK);
    assert.equal(buy.side, "BUY");
    assert.equal(buy.pros, 2);
    assert.equal(Math.round(buy.tokens), 258_805);
    assert.equal(buy.fee, 0.02);
    assert.equal(buy.block, 20_506_725);
    assert.equal(sell.side, "SELL");
    assert.equal(sell.tokens, 258_000);
    assert.equal(sell.pros.toFixed(4), "1.9541");
  });
});
