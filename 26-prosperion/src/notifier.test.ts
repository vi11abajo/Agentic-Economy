import { test } from "node:test";
import assert from "node:assert/strict";
import { parseEther, type Address } from "viem";
import { openStore } from "./store.js";
import { openAlertBook, parseSubs } from "./subscriptions.js";
import { makeNotifier, makeOutbox, type OutMessage } from "./notifier.js";
import type { Launch } from "./store.js";

const ME = "0x59F74eD82A08F80cff5D7E8055f6a24A18595F64" as Address;
const YOU = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb" as Address;
const MARKET = "0xBB3DC336E9221be62cc63e62E3969580B5BAB82c" as Address;
const OTHER = "0xE2Cb631588789954D275407e66C20bA6497CfF2A" as Address;
const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672" as Address;
const launch: Launch = {
  market: MARKET, vault: "0xc35d8e066ba00a1d433f08500eb1b6032d8cbf47", pToken: "0x05457dA2c193ce92C1877ec2B9eA3966bD54fafE", block: 100n, tx: "0xabc",
  checks: { market: MARKET, block: 101n, genuine: true, vault: null, pToken: null, phase: 0, reserveBefore: 0n, implNow: IMPL, amountIn: 0n, quoteOut: 0n },
};

function setup(limits: Awaited<ReturnType<Parameters<typeof makeNotifier>[0]["gate"]["readLimits"]>> = null) {
  const store = openStore(":memory:");
  const book = openAlertBook(store.db);
  const sent: OutMessage[] = [];
  let agent: (p: string) => Promise<string> = async () => "notes";
  const n = makeNotifier({
    store, book, out: async (m) => { sent.push(m); return sent.length; },
    gate: { readLimits: async () => limits, spentToday: async () => 0n },
    curatorOf: async () => null, askAgent: (p) => agent(p), agentTimeoutMs: 1_000,
    symbolOf: () => "pANTA", readHoldings: async () => ({ holdings: [] }),
  });
  const link = (address: Address, chat: number, subs: unknown) => {
    const s = parseSubs(subs);
    if ("error" in s) throw new Error(s.error);
    book.saveSubs(address, s);
    store.linkTelegram(store.newLinkCode(address), chat);
  };
  return { store, book, sent, n, link, setAgent: (f: typeof agent) => { agent = f; } };
}

test("a launch goes to launch subscribers, a ready buy to snipers, and the agent's notes reply to both", async () => {
  const { store, sent, n, link } = setup();
  link(ME, 1, { snipe: { on: true, amountPros: "0.5", maxInCurvePros: "0" } });
  link(YOU, 2, { launch: { on: true, maxInCurvePros: "0", skipCurators: [] } });
  await n.onLaunch(launch);
  const toMe = sent.filter((m) => m.chatId === 1), toYou = sent.filter((m) => m.chatId === 2);
  assert.match(toMe[0].html, /Snipe ready: 0\.5 PROS/);
  assert.ok(toMe[0].sign?.url.includes("/sign/?r="), "the snipe carries the sign page for the QR and wallet buttons");
  const reqId = toMe[0].sign!.url.split("r=")[1];
  const req = store.getRequest(reqId)!;
  assert.equal(req.params.owner, ME);
  assert.equal(req.params.amountWei, parseEther("0.5").toString());
  assert.match(toYou[0].html, /New Prosper launch/);
  // out() returns the message's place in `sent` as its id; the notes reply to that id in each chat
  assert.equal(toMe[1].replyTo, sent.indexOf(toMe[0]) + 1);
  assert.match(toMe[1].html, /agent's notes/);
  assert.equal(toYou[1].replyTo, sent.indexOf(toYou[0]) + 1);
  await n.onLaunch(launch);
  assert.equal(sent.length, 4, "the same launch seen again sends nothing new");
});

test("a snipe over your own gate limits says which limit instead of sending a link", async () => {
  const { sent, n, link } = setup({ maxPerBuy: parseEther("0.1"), maxPerDay: parseEther("0.3"), maxReserveBefore: 0n, acceptedMarketImpl: IMPL });
  link(ME, 1, { snipe: { on: true, amountPros: "10", maxInCurvePros: "0" } });
  await n.onLaunch(launch);
  assert.match(sent[0].html, /no link this time/);
  assert.match(sent[0].html, /above your limit of 0\.1 PROS per buy/);
  assert.equal(sent[0].sign, undefined);
});

test("progress goes only to the markets in your scope; a muted market stays quiet", async () => {
  const { book, sent, n, link } = setup();
  link(ME, 1, { progress: { on: true, thresholds: [50], phase: true, scope: "mine" } });
  link(YOU, 2, { progress: { on: true, thresholds: [50], phase: true, scope: "all" } });
  book.follow(ME, OTHER);
  await n.onBoard({ [MARKET]: { symbol: "pANTA", phase: 0, bps: 4_000 }, [OTHER]: { symbol: "pVIRU", phase: 0, bps: 4_000 } });
  assert.equal(sent.length, 0, "first look is a baseline");
  book.mute(YOU, OTHER, Date.now() + 60_000);
  await n.onBoard({ [MARKET]: { symbol: "pANTA", phase: 0, bps: 5_100 }, [OTHER]: { symbol: "pVIRU", phase: 0, bps: 5_100 } });
  assert.deepEqual(sent.map((m) => [m.chatId, /pANTA|pVIRU/.exec(m.html)![0]]), [[1, "pVIRU"], [2, "pANTA"]]);
});

test("whale trades respect size and scope; security alerts go only to the wallet the gate event names", async () => {
  const { sent, n, link } = setup();
  link(ME, 1, { whales: { on: true, minPros: "100", scope: "all" }, security: { on: true } });
  link(YOU, 2, { whales: { on: true, minPros: "100", scope: "mine" }, security: { on: true } });
  const t = { market: MARKET, block: 5n, tx: "0xdead" as const, logIndex: 1, kind: "buy" as const, trader: YOU, caller: YOU, prosGross: parseEther("150"), prosNet: parseEther("148.5"), tokens: 1n, fee: 0n };
  await n.onTrades([t, { ...t, logIndex: 2, prosGross: parseEther("50") }]);
  assert.deepEqual(sent.map((m) => m.chatId), [1]);
  await n.onGateEvents([{ kind: "bought", user: YOU, tx: "0x3d23", logIndex: 2, block: 9n, market: MARKET, value: parseEther("10"), out: 1n }]);
  assert.deepEqual(sent.map((m) => m.chatId), [1, 2]);
});

test("paused wallets get nothing until the pause ends", async () => {
  const { book, sent, n, link } = setup();
  link(ME, 1, { security: { on: true } });
  book.pause(ME, Date.now() + 60_000);
  const e = { kind: "bought" as const, user: ME, tx: "0x1", logIndex: 0, block: 1n, market: MARKET, value: 1n, out: 1n };
  await n.onGateEvents([e]);
  assert.equal(sent.length, 0);
  book.pause(ME, 0);
  await n.onGateEvents([e]);
  assert.equal(sent.length, 1);
});

test("the outbox waits out Telegram's 429 and keeps one chat's messages in order", async () => {
  const log: string[] = [];
  let first = true;
  const out = makeOutbox(async (m) => {
    if (m.html === "a" && first) { first = false; throw new Error("telegram sendMessage: Too Many Requests: retry after 1"); }
    log.push(m.html);
    return log.length;
  }, { gapMs: 0, sleep: async () => {} });
  const [a, b] = await Promise.all([out({ chatId: 1, html: "a" }), out({ chatId: 1, html: "b" })]);
  assert.deepEqual(log, ["a", "b"]);
  assert.deepEqual([a, b], [1, 2]);
  const dropped = await makeOutbox(async () => { throw new Error("Forbidden: bot was blocked by the user"); }, { gapMs: 0, sleep: async () => {} })({ chatId: 3, html: "x" });
  assert.equal(dropped, null);
});
