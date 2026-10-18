// Unit tests on real chain data (test/fixtures, recorded from Pharos Chain MCP get_logs): the ProsperFactory
// MarketCreated log of pMusk and the buy/sell made during the task 02 recording. The database runs in memory.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { openDb } from "./db.js";
import { BOUGHT, decodeMarketCreated, decodeTrade, MARKET_CREATED, SOLD, type MarketRow, type RpcLog } from "./prosper.js";
import { formatTrade } from "./telegram.js";

const fixture = (name: string) =>
  (JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8")) as { logs: RpcLog[] }).logs;
const [CREATED] = fixture("pmusk-market-created.json");
const [BUY, SELL] = fixture("pmusk-demo-logs.json");

const PMUSK: MarketRow = {
  market: "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f",
  pToken: "0xE318ac4113324841265d270Dc2393f1Bf742A7f8",
  vault: "0xb1acBc5186F2136904e9bD8E2a1d7120Ac46f0d8",
  creator: "0x9e46b14a1cf687E8846e452f65a7a3D3B93B3E98",
  symbol: "pMusk",
  name: "Musk",
  decimals: 18,
  createdBlock: 20_372_512,
  createdTime: 1_792_134_908,
  phase: 0,
};

describe("ProsperFactory MarketCreated", () => {
  it("decodes vault, creator, pToken and market of the real pMusk creation log", () => {
    assert.equal(CREATED.topics[0], MARKET_CREATED);
    const m = decodeMarketCreated(CREATED);
    assert.equal(m.market.toLowerCase(), PMUSK.market);
    assert.equal(m.pToken, PMUSK.pToken);
    assert.equal(m.vault, PMUSK.vault);
    assert.equal(m.creator, PMUSK.creator);
    assert.ok(m.vault.toLowerCase().endsWith("46f0d8"), "the app slug sxss-46f0d8 is the vault suffix");
    assert.equal(Number(BigInt(CREATED.blockNumber)), PMUSK.createdBlock);
  });
});

describe("curve trades", () => {
  it("decodes the recorded buy and sell", () => {
    assert.deepEqual([BUY.topics[0], SELL.topics[0]], [BOUGHT, SOLD]);
    const buy = decodeTrade(BUY, PMUSK);
    const sell = decodeTrade(SELL, PMUSK);
    assert.equal(buy.side, "BUY");
    assert.equal(buy.pros, 2);
    assert.equal(Math.round(buy.tokens), 258_805);
    assert.equal(buy.fee, 0.02);
    assert.equal(buy.block, 20_506_725);
    assert.equal(buy.time, 1_792_266_557);
    assert.equal(buy.id, `${BUY.transactionHash}:${Number(BigInt(BUY.logIndex))}`);
    assert.equal(sell.side, "SELL");
    assert.equal(sell.tokens, 258_000);
    assert.equal(sell.pros.toFixed(4), "1.9541");
    assert.equal(sell.block, 20_506_762);
  });
});

describe("database", () => {
  const db = openDb(":memory:");
  db.upsertMarket(PMUSK);
  const buy = decodeTrade(BUY, PMUSK);
  const sell = decodeTrade(SELL, PMUSK);

  it("stores a trade once, whatever the indexer replays", () => {
    assert.equal(db.insertTrade(buy), true);
    assert.equal(db.insertTrade(sell), true);
    assert.equal(db.insertTrade(buy), false, "same txHash:logIndex is a duplicate");
    assert.equal(db.trades({ limit: 50 }).length, 2);
  });

  it("filters trades newest first by side, size, trader and block", () => {
    assert.deepEqual(db.trades({ market: PMUSK.market }).map((t) => t.side), ["SELL", "BUY"]);
    assert.deepEqual(db.trades({ side: "BUY" }).map((t) => t.block), [20_506_725]);
    assert.equal(db.trades({ minPros: 1.96 }).length, 1);
    assert.equal(db.trades({ trader: buy.trader.toLowerCase() }).length, 2);
    assert.deepEqual(db.trades({ afterBlock: 20_506_725 }).map((t) => t.side), ["SELL"]);
    assert.equal(db.trades({ markets: [] }).length, 0, "no on-curve markets means no trades");
  });

  it("computes stats and the PROS left on the curve", () => {
    const s = db.stats(PMUSK.market, 0);
    assert.deepEqual({ trades: s.trades, buys: s.buys, sells: s.sells, traders: s.traders }, { trades: 2, buys: 1, sells: 1, traders: 1 });
    const expected = buy.pros - buy.fee - (sell.pros + sell.fee);
    assert.ok(Math.abs(db.netCurvePros(PMUSK.market) - expected) < 1e-12);
  });

  it("keeps Telegram subscriptions per chat and market", () => {
    db.addSub(1, "alice", PMUSK.market, 1);
    db.addSub(1, "alice", "*", 0);
    db.addSub(2, "Bob", PMUSK.market, 0);
    assert.equal(db.subsByMarket(PMUSK.market).length, 3, "market subscribers + 'all tokens'");
    assert.equal(db.subsByUsername("bob").length, 1, "usernames match case-insensitively");
    db.delAllSubs(1);
    assert.equal(db.subsByChat(1).length, 0);
  });
});

describe("Telegram alert", () => {
  it("shows side, amounts, block and UTC time with explorer links", () => {
    const text = formatTrade(decodeTrade(BUY, PMUSK));
    assert.match(text, /^🟢 <b>BUY · pMusk<\/b>/);
    assert.match(text, /<b>2 PROS<\/b> → <b>258,805 pMusk<\/b>/);
    assert.match(text, /🧱 Block {2}20,506,725/);
    assert.match(text, /17\.10\.2026 - 19\.49\.17 UTC/);
    assert.match(text, /pharosscan\.xyz\/tx\/0x69a893b5/);
    assert.match(text, /pharosscan\.xyz\/address\/0x59F74eD82A08F80cff5D7E8055f6a24A18595F64/);
  });
});
