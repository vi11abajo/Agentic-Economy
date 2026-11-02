import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { run, type RunDeps } from "./digest.js";
import type { Net } from "./deliver.js";
import { DEFAULT_CONFIG, readHistory, saveConfig } from "./store.js";
import { addr, buy, created, fakeChain, sell } from "./testkit.js";

const T0 = Date.parse("2026-10-19T00:00:00Z") / 1000; // block 0
const NOW = Date.parse("2026-11-03T09:00:00Z") / 1000;
const HEAD = NOW - T0 - 60;
const M1 = addr(1), M2 = addr(2), A = addr(11), B = addr(12);
const W = 604_800; // blocks per week at 1 block/s

function setup(opts: { tgFails?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "pd-"));
  saveConfig(home, { ...DEFAULT_CONFIG, channels: { telegram: true, discord: true }, schedule: { ...DEFAULT_CONFIG.schedule, tz: "UTC" } });
  writeFileSync(join(home, ".env"), "PROSPERDIGEST_TELEGRAM_BOT_TOKEN=123:abc\nPROSPERDIGEST_TELEGRAM_CHAT_ID=42\nPROSPERDIGEST_DISCORD_WEBHOOK=https://discord.com/api/webhooks/1/tok\n");
  const logs = [
    created(M1, addr(101), 100),
    buy(M1, A, 10, 0.001, 200),
    created(M2, addr(102), W + 50),
    buy(M1, A, 20, 0.001, W + 100),
    buy(M2, B, 5, 0.002, W + 200),
    sell(M1, A, 4, 0.0012, W + 300),
  ];
  const chain = fakeChain(logs, { head: HEAD, t0: T0 });
  const sent: string[] = [];
  const state = { tgFails: !!opts.tgFails, docFailsOnce: false };
  const net = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes("telegram") && state.tgFails) return new Response(JSON.stringify({ ok: false, description: "Bad Request: chat not found" }), { status: 400 });
    if (u.endsWith("sendDocument") && state.docFailsOnce) {
      state.docFailsOnce = false;
      sent.push("tg:sendDocument(failed)");
      return new Response(JSON.stringify({ ok: false, description: "Internal Server Error" }), { status: 500 });
    }
    sent.push(u.includes("telegram") ? `tg:${u.split("/").pop()}` : "discord");
    return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 });
  }) as Net;
  const deps: RunDeps = { chain, home, net, now: () => NOW, sleep: async () => {}, scanStart: 0 };
  return { home, chain, sent, deps, state };
}

describe("run", () => {
  it("first run reads the period and the one before, sends both channels, keeps history", async () => {
    const { home, sent, deps } = setup();
    const r = await run(deps, {});
    assert.equal(r.period, "2026-10-26_7d");
    assert.deepEqual(r.sent, { telegram: "sent", discord: "sent" });
    assert.deepEqual(sent, ["tg:sendMessage", "tg:sendDocument", "discord"]);
    const h = readHistory(home);
    assert.equal(h.length, 1);
    const d = h[0];
    assert.equal(d.metrics.trades, 3);
    assert.equal(d.metrics.volume, 29);
    assert.equal(d.metrics.newMarkets, 1);
    assert.equal(d.metrics.newTraders, 1, "B is new, A traded the week before");
    assert.equal(d.prev?.trades, 1);
    assert.ok(d.delivered.telegram && d.delivered.discord);
    assert.ok(readdirSync(join(home, "reports")).includes("prosper-digest-2026-10-26_7d.html"));
  });

  it("a second run for the same period sends nothing and reads no activity", async () => {
    const { chain, sent, deps } = setup();
    await run(deps, {});
    sent.length = 0;
    chain.logCalls.length = 0;
    const r = await run(deps, {});
    assert.deepEqual(r.sent, { telegram: "already", discord: "already" });
    assert.deepEqual(sent, []);
    assert.equal(chain.logCalls.length, 0);
  });

  it("the catch-up check does nothing before the digest is due", async () => {
    const { sent, deps } = setup();
    const early = Date.parse("2026-11-02T08:00:00Z") / 1000; // due Monday 09:00 UTC
    const r = await run({ ...deps, now: () => early }, { catchUp: true });
    assert.equal(r.built, false);
    assert.deepEqual(sent, []);
  });

  it("one channel failing does not stop the other, and the next run sends only the failed one", async () => {
    const { home, sent, deps, state } = setup({ tgFails: true });
    const r = await run(deps, {});
    assert.deepEqual(r.sent, { telegram: "failed", discord: "sent" });
    assert.deepEqual(sent, ["discord"]);
    state.tgFails = false;
    sent.length = 0;
    const r2 = await run(deps, { catchUp: true });
    assert.deepEqual(r2.sent, { telegram: "sent", discord: "already" });
    assert.deepEqual(sent, ["tg:sendMessage", "tg:sendDocument"]);
    assert.equal(readHistory(home).length, 1, "the same digest, not a new one");
  });

  it("a retry after the summary went out resends only the report file, not the summary", async () => {
    const { sent, deps, state } = setup();
    state.docFailsOnce = true;
    const r = await run(deps, {});
    assert.equal(r.sent.telegram, "sent");
    assert.deepEqual(sent.filter((s) => s.startsWith("tg:")), ["tg:sendMessage", "tg:sendDocument(failed)", "tg:sendDocument"]);
  });

  it("a chain failure is written to run.log and the run fails", async () => {
    const { home, chain, deps } = setup();
    chain.logs = async () => {
      throw new Error("MCP get_logs failed: 503");
    };
    await assert.rejects(run(deps, {}), /503/);
    assert.match(readFileSync(join(home, "run.log"), "utf8"), /2026-10-26_7d: build failed: MCP get_logs failed: 503/);
  });

  it("a closed period is not read before the chain has reached its end", async () => {
    const { deps } = setup();
    const endOfPeriod = Date.parse("2026-11-02T00:00:00Z") / 1000;
    const lagging = fakeChain([], { head: endOfPeriod - T0 - 5, t0: T0 }); // head 5 s before the period's end
    await assert.rejects(run({ ...deps, chain: lagging, now: () => endOfPeriod + 2 }, {}), /has not reached/);
  });

  it("dry builds and sends nothing", async () => {
    const { home, sent, deps } = setup();
    const r = await run(deps, { dry: true });
    assert.equal(r.built, true);
    assert.deepEqual(sent, []);
    assert.deepEqual(readHistory(home)[0].delivered, {});
  });
});
