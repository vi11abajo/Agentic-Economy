import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { blockAtTime } from "./chain.js";
import { emptyRegistry, extendRegistry, loadRegistry, readRange } from "./scan.js";
import { addr, buy, created, fakeChain, sell } from "./testkit.js";

const M1 = addr(1), M2 = addr(2), T1 = addr(11), T2 = addr(12);

describe("readRange", () => {
  it("counts trades of a market created in the same window", async () => {
    const chain = fakeChain([created(M1, addr(101), 1500), buy(M1, T1, 10, 0.001, 1501)], { head: 3000 });
    const reg = emptyRegistry(1000);
    const r = await readRange(chain, reg, 1000, 2999);
    assert.equal(r.created.length, 1);
    assert.equal(r.trades.length, 1);
    assert.equal(r.trades[0].pros, 10);
    assert.equal(reg.scannedTo, 2999);
  });

  it("counts a trade logged before its MarketCreated in the same block", async () => {
    const first = buy(M1, T1, 3, 0.001, 700);
    const later = { ...created(M1, addr(101), 700), logIndex: "0x5" as const };
    const chain = fakeChain([first, later], { head: 1000 });
    const r = await readRange(chain, emptyRegistry(0), 0, 999);
    assert.equal(r.trades.length, 1);
  });

  it("ignores Bought/Sold from addresses that are not Prosper markets", async () => {
    const chain = fakeChain([created(M1, addr(101), 10), buy(M2, T1, 5, 0.001, 20)], { head: 100 });
    const r = await readRange(chain, emptyRegistry(0), 0, 100);
    assert.equal(r.trades.length, 0);
  });

  it("keeps each trader's first trade block across ranges", async () => {
    const chain = fakeChain([created(M1, addr(101), 10), buy(M1, T1, 1, 0.001, 50), sell(M1, T1, 1, 0.001, 1200), buy(M1, T2, 1, 0.001, 1300)], { head: 2000 });
    const reg = emptyRegistry(0);
    await readRange(chain, reg, 0, 20);
    await readRange(chain, reg, 1000, 1999);
    assert.equal(reg.traders[T1.toLowerCase()], 1200);
    await readRange(chain, reg, 21, 999);
    assert.equal(reg.traders[T1.toLowerCase()], 50);
    assert.equal(reg.traders[T2.toLowerCase()], 1300);
  });

  it("asks for several windows at once but processes them in chain order", async () => {
    const chain = fakeChain([created(M1, addr(101), 10), buy(M1, T1, 1, 0.001, 1500), buy(M1, T2, 2, 0.001, 2500)], { head: 5000 });
    let inFlight = 0, peak = 0;
    const plain = chain.logs;
    chain.logs = async (f, t) => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((r) => setTimeout(r, f === 0 ? 30 : 5)); // the first window answers last
      inFlight--;
      return plain(f, t);
    };
    const r = await readRange(chain, emptyRegistry(0), 0, 4999);
    assert.ok(peak > 1, `peak concurrency ${peak}`);
    assert.deepEqual(r.trades.map((t) => t.block), [1500, 2500], "the market from window 0 was known when window 1 was processed");
  });

  it("never asks for more than 1000 blocks at once", async () => {
    const chain = fakeChain([], { head: 5000 });
    await readRange(chain, emptyRegistry(0), 0, 4321);
    assert.ok(chain.logCalls.every(([f, t]) => t - f <= 999));
    assert.equal(chain.logCalls.at(-1)![1], 4321);
  });
});

describe("blockAtTime", () => {
  it("finds the first block at or after a time on an irregular chain", async () => {
    const times = (b: number) => 1000 + b * 2 + (b > 500 ? 7 : 0);
    const chain = fakeChain([], { head: 2000, times });
    const b = await blockAtTime(chain, 1000 + 600 * 2 + 7, 2000);
    assert.equal(b, 600);
    assert.equal(await blockAtTime(chain, 1000 + 600 * 2 + 6, 2000), 600);
    assert.equal(await blockAtTime(chain, 1000 + 599 * 2 + 8, 2000), 600);
  });
});

describe("extendRegistry", () => {
  it("resumes from where the last scan stopped and saves it", async () => {
    const home = mkdtempSync(join(tmpdir(), "pd-"));
    const chain = fakeChain([created(M1, addr(101), 100), buy(M1, T1, 1, 0.001, 2500)], { head: 3000 });
    await extendRegistry(chain, home, 1999, 0);
    assert.equal(loadRegistry(home, 0).scannedTo, 1999);
    chain.logCalls.length = 0;
    await extendRegistry(chain, home, 2999, 0);
    assert.equal(chain.logCalls[0][0], 2000);
    const reg = loadRegistry(home, 0);
    assert.equal(Object.keys(reg.markets).length, 1);
    assert.equal(reg.traders[T1.toLowerCase()], 2500);
  });
});
