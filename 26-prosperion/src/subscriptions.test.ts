import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "./store.js";
import { openAlertBook, parseSubs, DEFAULT_SUBS } from "./subscriptions.js";

const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const YOU = "0x59F74eD82A08F80cff5D7E8055f6a24A18595F64";
const MARKET = "0xBB3DC336E9221be62cc63e62E3969580B5BAB82c";

test("what the Alerts page sends is checked kind by kind; a bad field names itself", () => {
  const ok = parseSubs({
    launch: { on: true, maxInCurvePros: "0", skipCurators: ["0xfaeccf5a7cde65fe358e9547cc80046f6dbc2c1a"] },
    snipe: { on: true, amountPros: "0.5", maxInCurvePros: "0" },
    progress: { on: true, thresholds: [50, 90], phase: true, scope: "all" },
    positions: { on: false, movePct: 15, navMovePct: 1 },
    whales: { on: true, minPros: "250", scope: "mine" },
    security: { on: true },
    digest: { on: true, hourUtc: 8 },
  });
  assert.ok(!("error" in ok));
  if ("error" in ok) return;
  assert.equal(ok.snipe.amountPros, "0.5");
  assert.deepEqual(ok.progress.thresholds, [50, 90]);
  assert.equal(ok.digest.hourUtc, 8);

  const bad = (x: unknown) => { const r = parseSubs(x); return "error" in r ? r.error : ""; };
  assert.match(bad({ snipe: { on: true, amountPros: "5000", maxInCurvePros: "0" } }), /snipe.*amount/i);
  assert.match(bad({ progress: { on: true, thresholds: [33], phase: true, scope: "all" } }), /progress.*thresholds/i);
  assert.match(bad({ whales: { on: true, minPros: "abc", scope: "all" } }), /whales/i);
  assert.match(bad({ digest: { on: true, hourUtc: 24 } }), /digest/i);
  assert.match(bad({ launch: { on: true, maxInCurvePros: "0", skipCurators: ["nope"] } }), /launch.*curator/i);
});

test("a kind the page leaves out keeps its defaults, switched off", () => {
  const r = parseSubs({ security: { on: true } });
  assert.ok(!("error" in r));
  if ("error" in r) return;
  assert.equal(r.security.on, true);
  assert.equal(r.snipe.on, false);
  assert.equal(r.snipe.amountPros, DEFAULT_SUBS.snipe.amountPros);
});

test("subscriptions are kept per wallet and only linked, unpaused chats get anything", () => {
  const store = openStore(":memory:");
  const book = openAlertBook(store.db);
  const subs = parseSubs({ security: { on: true }, whales: { on: true, minPros: "100", scope: "all" } });
  if ("error" in subs) throw new Error(subs.error);
  book.saveSubs(ME, subs);
  assert.equal(book.subsOf(ME).whales.minPros, "100");
  assert.deepEqual(book.recipients("security"), [], "not linked to Telegram yet");

  const code = store.newLinkCode(ME);
  assert.equal(store.linkTelegram(code, 4242), ME, "linking no longer needs a launch watch first");
  assert.deepEqual(book.recipients("security").map((r) => [r.address, r.chatId]), [[ME, 4242]]);
  assert.deepEqual(book.recipients("digest"), [], "a kind that is off has no recipients");

  book.pause(ME, Date.now() + 3_600_000);
  assert.deepEqual(book.recipients("security"), [], "paused");
  book.pause(ME, 0);
  assert.equal(book.recipients("security").length, 1);
  assert.deepEqual(book.addressesOfChat(4242), [ME]);
});

test("follows and mutes are per wallet and per market", () => {
  const book = openAlertBook(openStore(":memory:").db);
  book.follow(ME, MARKET);
  assert.deepEqual(book.follows(ME), [MARKET]);
  assert.deepEqual(book.follows(YOU), []);
  assert.equal(book.isMuted(ME, MARKET), false);
  book.mute(ME, MARKET, Date.now() + 60_000);
  assert.equal(book.isMuted(ME, MARKET), true);
  assert.equal(book.isMuted(ME, MARKET.toLowerCase()), true, "addresses compare in any case");
  book.unfollow(ME, MARKET);
  assert.deepEqual(book.follows(ME), []);
});

test("one event reaches one wallet once, even if two sources see it or the server restarts", () => {
  const store = openStore(":memory:");
  const book = openAlertBook(store.db);
  assert.equal(book.claim(ME, "whale:0xabc:3"), true);
  assert.equal(book.claim(ME, "whale:0xabc:3"), false);
  assert.equal(openAlertBook(store.db).claim(ME, "whale:0xabc:3"), false, "a second opener of the same file agrees");
  assert.equal(book.claim(YOU, "whale:0xabc:3"), true, "another wallet still gets it");
  book.setState("board", { a: 1 });
  assert.deepEqual(book.getState("board"), { a: 1 });
  assert.equal(book.getState("nothing"), null);
});
