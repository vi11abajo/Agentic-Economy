// Order books recorded from the three exchanges (test/fixtures), and the route arithmetic on venues with known
// prices, so every cost line can be checked by hand.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { buyWithQuote, parseBook, sellBase, type Book, type Exchange } from "./cex.js";
import { DEFAULTS, apply } from "./config.js";
import { costRoute, decide, type Leg, type Venue } from "./routes.js";

const fixture = (ex: Exchange) => parseBook(ex, JSON.parse(readFileSync(new URL(`../test/fixtures/${ex}-book.json`, import.meta.url), "utf8")));

describe("order books from the exchanges' public APIs", () => {
  for (const ex of ["okx", "bitget", "mexc"] as Exchange[]) {
    it(`reads ${ex}: bids high to low, asks low to high, best bid below best ask`, () => {
      const b = fixture(ex);
      assert.ok(b.bids.length > 5 && b.asks.length > 5);
      assert.ok(b.bids[0][0] < b.asks[0][0], "the book isn't crossed");
      for (let i = 1; i < b.bids.length; i++) assert.ok(b.bids[i][0] <= b.bids[i - 1][0]);
      for (let i = 1; i < b.asks.length; i++) assert.ok(b.asks[i][0] >= b.asks[i - 1][0]);
    });
  }

  it("says so when an exchange answers with an error", () => {
    assert.throws(() => parseBook("okx", { code: "51001", msg: "Instrument ID does not exist", data: [] }), /okx: Instrument ID does not exist/);
    assert.throws(() => parseBook("mexc", { code: -1121, msg: "Invalid symbol." }), /mexc: Invalid symbol/);
  });
});

const book: Book = { exchange: "okx", bids: [[0.67, 100], [0.66, 100]], asks: [[0.68, 100], [0.69, 100]], at: 0 };

describe("filling against a book", () => {
  it("a buy walks up the asks: the average and the deepest price touched", () => {
    const f = buyWithQuote(book, 0.68 * 100 + 0.69 * 50); // all of the first level, half of the second
    assert.equal(f.base, 150);
    assert.ok(Math.abs(f.avg - (68 + 34.5) / 150) < 1e-12);
    assert.equal(f.worst, 0.69);
    assert.equal(f.complete, true);
  });

  it("a sell walks down the bids, and says when the book is too thin", () => {
    const f = sellBase(book, 150);
    assert.equal(f.quote, 67 + 33);
    assert.equal(f.worst, 0.66);
    assert.equal(sellBase(book, 500).complete, false);
  });
});

/** A venue with fixed prices and costs, so the route math can be checked by hand. */
function venue(id: string, kind: "dex" | "cex", ask: number, bid: number, feePct: number, gasUsd = 0, withdrawPros = 0): Venue {
  const fee = feePct / 100;
  return {
    id, kind, askUsd: ask, bidUsd: bid, withdrawPros, depositPros: 0,
    async buy(usd): Promise<Leg> {
      return { pros: (usd / ask) * (1 - fee), usd, feeUsd: usd * fee, gasUsd, complete: true, prepared: { venue: id, side: "buy" } };
    },
    async sell(pros): Promise<Leg> {
      return { pros, usd: pros * bid * (1 - fee), feeUsd: pros * bid * fee, gasUsd, complete: true, prepared: { venue: id, side: "sell" } };
    },
  };
}

async function route(b: Venue, s: Venue, size: number, settings = DEFAULTS, prosUsd = 0.67) {
  const buy = await b.buy(size);
  const sell = await s.sell(buy.pros);
  return costRoute(b, s, size, buy, sell, prosUsd, settings);
}

describe("net profit after fees, slippage, gas and the rebalance", () => {
  it("adds up: gross - fees - slippage - gas - rebalance = net", async () => {
    const r = await route(venue("dex", "dex", 0.66, 0.66, 0.01, 0.002), venue("okx", "cex", 0.669, 0.67, 0.1), 200);
    assert.ok(Math.abs(r.grossPct - ((0.67 - 0.66) / 0.66) * 100) < 1e-9);
    assert.ok(Math.abs(r.grossUsd - r.feesUsd - r.slippageUsd - r.gasUsd - r.rebalanceUsd - r.netUsd) < 1e-9);
    assert.ok(r.netUsd > 0 && r.netUsd < r.grossUsd, "fees and gas eat part of the spread");
  });

  it("a CEX buy pays the PROS withdrawal to move the coins to the other side, unless rebalance is off", async () => {
    const mexc = venue("mexc", "cex", 0.66, 0.659, 0.08, 0, 0.2);
    const r = await route(mexc, venue("dex", "dex", 0.67, 0.67, 0.01, 0.002), 200);
    assert.ok(Math.abs(r.rebalanceUsd - 0.2 * 0.67) < 1e-12);
    const off = await route(mexc, venue("dex", "dex", 0.67, 0.67, 0.01, 0.002), 200, apply(DEFAULTS, ["rebalance=off"]));
    assert.equal(off.rebalanceUsd, 0);
    assert.ok(Math.abs(off.netUsd - r.netUsd - 0.2 * 0.67) < 1e-9);
  });

  it("a route the book can't fill is never chosen", async () => {
    const thin: Venue = { ...venue("bitget", "cex", 0.6, 0.6, 0.1), async buy(usd) { return { ...(await venue("bitget", "cex", 0.6, 0.6, 0.1).buy(usd)), complete: false }; } };
    const r = await route(thin, venue("dex", "dex", 0.7, 0.7, 0.01), 200);
    assert.equal(r.ok, false);
    assert.equal(r.note, "bitget book too thin for $200");
    assert.equal(decide([r], DEFAULTS).action, "SKIP");
  });
});

describe("a pool that can't take the size", () => {
  it("is never chosen, however good its mid price looks (seen live: +2.07% gross, almost nothing paid out)", async () => {
    const shallow: Venue = { ...venue("faroswap-0.05%", "dex", 0.68, 0.68, 0.05), async sell(pros) { return { ...(await venue("x", "dex", 0.68, 0.68, 0.05).sell(pros)), usd: 0.01, complete: false }; } };
    const r = await route(venue("okx", "cex", 0.666, 0.665, 0.1), shallow, 1000);
    assert.ok(r.grossPct > 2);
    assert.equal(r.ok, false);
    assert.equal(r.note, "faroswap-0.05% pool too thin for $1000");
    assert.equal(decide([r], DEFAULTS).reason, "no route can be filled at these sizes");
  });
});

describe("acting only above the threshold", () => {
  const good = () => route(venue("dex", "dex", 0.66, 0.66, 0.01, 0.002), venue("okx", "cex", 0.669, 0.67, 0.1), 200);
  const flat = () => route(venue("dex", "dex", 0.667, 0.667, 0.01, 0.002), venue("okx", "cex", 0.6665, 0.6668, 0.1), 200);

  it("ACT when the best route clears both the dollar and the percent threshold, with its prepared legs", async () => {
    const d = decide([await flat(), await good()], DEFAULTS);
    assert.equal(d.action, "ACT");
    assert.equal(d.best!.route, "buy dex → sell okx");
    assert.equal(d.best!.legs!.buy.prepared.venue, "dex");
  });

  it("SKIP with the reason when it doesn't, naming the threshold it missed", async () => {
    const d = decide([await flat()], DEFAULTS);
    assert.equal(d.action, "SKIP");
    assert.match(d.reason, /^best: buy dex → sell okx at \$200: gross -0\.\d+%/);
    assert.match(d.reason, /Below the threshold: net -\$[\d.]+ < \$1\.000 and -[\d.]+% < \+0\.100%/);
  });

  it("the threshold is a setting: raise it and the same route is skipped", async () => {
    const high = apply(DEFAULTS, ["min_net_usd=50"]);
    const d = decide([await good()], high);
    assert.equal(d.action, "SKIP");
    assert.match(d.reason, /< \$50\.00/);
  });
});

describe("settings", () => {
  it("are changed the way people type them", () => {
    const s = apply(DEFAULTS, ["min_net_usd=$0.5", "min_net_pct=0.05%", "sizes_usd=100,500", "okx.taker_pct=0.08", "mexc.withdraw_pros=0.1"]);
    assert.equal(s.min_net_usd, 0.5);
    assert.equal(s.min_net_pct, 0.05);
    assert.deepEqual(s.sizes_usd, [100, 500]);
    assert.equal(s.exchanges.okx.taker_pct, 0.08);
    assert.equal(s.exchanges.mexc.withdraw_pros, 0.1);
    assert.equal(DEFAULTS.exchanges.okx.taker_pct, 0.1, "defaults are left alone");
    assert.throws(() => apply(DEFAULTS, ["okx.maker=1"]), /Unknown setting okx\.maker/);
  });
});
