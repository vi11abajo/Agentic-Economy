import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { pickEvents } from "./events.js";
import type { Trade } from "./prosper.js";
import type { TokenStat } from "./types.js";

const tr = (pros: number, market = "m1", trader = "0xaaaa000000000000000000000000000000000001", side: "BUY" | "SELL" = "BUY"): Trade => ({
  id: `${Math.random()}`, market, symbol: market.toUpperCase(), side, trader, pros, tokens: pros, fee: 0, price: 1, block: 1, time: 1, tx: `0xtx${pros}`,
});
const tok = (market: string, volume: number, trades: number, changePct: number | null): TokenStat => ({ market, symbol: market.toUpperCase(), volume, trades, firstPrice: 1, lastPrice: 1, changePct, phaseEnd: 0 });

describe("top 3 events", () => {
  const small = Array.from({ length: 20 }, (_, i) => tr(1, "m1", `0x${String(i).padStart(40, "0")}`));

  it("puts graduations first, then the strongest other kinds", () => {
    const trades = [...small, tr(100, "m1")];
    const r = pickEvents({ trades, tokens: [tok("m1", 120, 21, 10)], created: [], graduated: [{ market: "g1", symbol: "MOON" }, { market: "g2", symbol: "SUN" }], days: 7 });
    assert.deepEqual(r.top.map((e) => e.kind), ["graduation", "graduation", "big_trade"]);
    assert.equal(r.top[2].tx, "0xtx100");
    assert.match(r.top[0].title, /graduated to FaroSwap/);
  });

  it("takes at most one event per kind besides graduations", () => {
    const trades = [...small, tr(100, "m1"), tr(90, "m1")];
    const r = pickEvents({ trades, tokens: [tok("m1", 210, 22, 300)], created: [], graduated: [], days: 7 });
    assert.equal(r.top.filter((e) => e.kind === "big_trade").length, 1);
    assert.ok(r.top.length <= 3);
  });

  it("ignores a price move on a token with too few trades", () => {
    const r = pickEvents({ trades: small, tokens: [tok("m1", 20, 20, 5), tok("dust", 0.5, 2, 900)], created: [], graduated: [], days: 7 });
    assert.ok(!r.candidates.some((e) => e.kind === "mover" && e.market === "dust"));
  });

  it("a quiet period has no events", () => {
    assert.deepEqual(pickEvents({ trades: [], tokens: [], created: [], graduated: [], days: 7 }).top, []);
  });
});
