// Unit tests on real data: test/fixtures/pmusk-demo-logs.json holds the two pMusk curve logs returned by Pharos
// Chain MCP get_logs for the buy and the sell made during the walkthrough recording (blocks 20,506,725 / 20,506,762).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  BOUGHT,
  decodeTrade,
  fmt,
  logId,
  MAX_LOG_RANGE,
  num,
  pickNewTrades,
  short,
  SOLD,
  windowEnd,
  type Market,
  type RpcLog,
} from "./curve.js";

const { logs: LOGS } = JSON.parse(readFileSync(new URL("../test/fixtures/pmusk-demo-logs.json", import.meta.url), "utf8")) as { logs: RpcLog[] };
const [BUY_LOG, SELL_LOG] = LOGS;

const PMUSK: Market = {
  market: "0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F",
  pToken: "0xE318ac4113324841265d270Dc2393f1Bf742A7f8",
  symbol: "pMusk",
  name: "SPACE X Strategy (sxss)",
  decimals: 18,
};
const markets = (m: Partial<Market> = {}) => new Map([[PMUSK.market.toLowerCase(), { ...PMUSK, ...m }]]);
const ME = "0x59F74eD82A08F80cff5D7E8055f6a24A18595F64";

describe("event signatures", () => {
  it("match topic0 of the real Bought / Sold logs", () => {
    assert.equal(BUY_LOG.topics[0], BOUGHT);
    assert.equal(SELL_LOG.topics[0], SOLD);
  });
});

describe("decodeTrade", () => {
  it("decodes the recorded buy", () => {
    const t = decodeTrade(BUY_LOG, PMUSK);
    assert.equal(t.side, "BUY");
    assert.equal(t.trader, ME);
    assert.equal(t.pros, "2");
    assert.equal(num(t.tokens), "258,805");
    assert.equal(t.fee, "0.02");
    assert.equal(t.price.toPrecision(4), "0.000007651");
    assert.equal(t.block, 20_506_725);
    assert.equal(t.time, "2026-10-17T19:49:17.000Z");
    assert.equal(t.tx, "0x69a893b51be232849030f217e51fd1c37b4aecf007be7153b107f8439c3ecb42");
  });

  it("decodes the recorded sell (PROS received after the fee)", () => {
    const t = decodeTrade(SELL_LOG, PMUSK);
    assert.equal(t.side, "SELL");
    assert.equal(t.trader, ME);
    assert.equal(t.tokens, "258000");
    assert.equal(num(t.pros), "1.9541");
    assert.equal(t.block, 20_506_762);
    assert.equal(t.time, "2026-10-17T19:49:56.000Z");
    assert.ok(Number(t.fee) > 0);
  });

  it("has no time when the log carries no blockTimestamp", () => {
    const { blockTimestamp: _, ...noTime } = BUY_LOG;
    assert.equal(decodeTrade(noTime as RpcLog, PMUSK).time, undefined);
  });
});

describe("pickNewTrades", () => {
  it("returns trades in chain order, whatever order the page came in", () => {
    const trades = pickNewTrades([SELL_LOG, BUY_LOG], markets(), new Set());
    assert.deepEqual(trades.map((t) => t.side), ["BUY", "SELL"]);
  });

  it("reports each log once — within a page and across polls", () => {
    const seen = new Set<string>();
    assert.equal(pickNewTrades([BUY_LOG, BUY_LOG, SELL_LOG], markets(), seen).length, 2);
    assert.equal(pickNewTrades([BUY_LOG, SELL_LOG], markets(), seen).length, 0, "second poll over the same blocks");
    assert.deepEqual([...seen], [logId(BUY_LOG), logId(SELL_LOG)]);
  });

  it("skips logs removed by a re-org and logs of markets it does not watch", () => {
    const removed = { ...BUY_LOG, removed: true };
    const other = { ...SELL_LOG, address: "0x0000000000000000000000000000000000000001" as const };
    assert.equal(pickNewTrades([removed, other], markets(), new Set()).length, 0);
  });

  it("applies the market's minimum trade size in PROS", () => {
    assert.equal(pickNewTrades(LOGS, markets({ minPros: 1 }), new Set()).length, 2);
    assert.deepEqual(pickNewTrades(LOGS, markets({ minPros: 1.96 }), new Set()).map((t) => t.side), ["BUY"]);
    assert.equal(pickNewTrades(LOGS, markets({ minPros: 5 }), new Set()).length, 0);
  });
});

describe("windowEnd", () => {
  it("never spans more than the 1,000-block get_logs limit and stops at the safe head", () => {
    assert.equal(windowEnd(100n, 10_000n) - 100n + 1n, MAX_LOG_RANGE);
    assert.equal(windowEnd(100n, 500n), 500n);
    assert.equal(windowEnd(20_506_725n, 20_506_725n), 20_506_725n);
  });
});

describe("formatting", () => {
  it("groups block numbers and shortens addresses", () => {
    assert.equal(fmt(20_506_725n), "20,506,725");
    assert.equal(short(ME), "0x59F7…5F64");
    assert.equal(num("0.000123456789"), "0.000123");
    assert.equal(num("12.3456789"), "12.3457");
  });
});
