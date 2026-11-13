import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData } from "viem";
import { createApi, GATE_ABI, type ApiDeps } from "./api.js";
import { openStore } from "./store.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./auth.js";
import type { MarketCheck } from "./market.js";

const MARKET = "0x94228EB493173E75a12e76E667bfe9b0939aae64";
const IMPL = "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672";
const GATE = "0x0000000000000000000000000000000000006a7e";
const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";

const check = (over: Partial<MarketCheck> = {}): MarketCheck => ({
  market: MARKET, block: 100n, genuine: true, vault: "0x251a68B711EA3967B434EefCA49D43cD133Ef3ee",
  pToken: "0x14C150c0D60006d0CDdDcA860bA7C50F180baf81", phase: 0, reserveBefore: 0n, implNow: IMPL,
  amountIn: 10n ** 17n, quoteOut: 1_000_000n, ...over,
});

async function serve(over: Partial<ApiDeps> = {}) {
  const store = openStore(":memory:");
  const deps: ApiDeps = {
    store,
    gate: GATE,
    check: async () => check(),
    readLimits: async () => ({ maxPerBuy: 10n ** 18n, maxPerDay: 10n ** 19n, maxReserveBefore: 0n, acceptedMarketImpl: IMPL }),
    spentToday: async () => 0n,
    marketImpl: async () => IMPL,
    readVault: async () => ({ ok: true }),
    listVaults: async () => [{ vaultName: "Barker Neutral Carry", r25Vault: "0x3ed49843a55952a399db99c8949f67a9d821611c" }],
    explainNavMove: async () => ({ ok: true }),
    agent: async () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    telegramBot: () => null,
    perMinute: 20,
    userDaily: 30,
    dailyCap: 300,
    now: () => 1_800_000_000,
    ...over,
  };
  const http = createServer(createApi(deps));
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  return { base, store, close: () => new Promise<void>((r) => http.close(() => r())) };
}

const buyRequest = (store: ReturnType<typeof openStore>, maxReserveBeforeWei = "0", acceptedImpl = IMPL) =>
  store.saveRequest({
    kind: "buy", createdBlock: 90n,
    params: { market: MARKET, amountWei: (10n ** 17n).toString(), minOutBps: 9800, maxReserveBeforeWei, acceptedImpl, owner: ME },
  });

test("a push link opened after someone else bought refuses before the wallet opens", async () => {
  const s = await serve({ check: async () => check({ reserveBefore: 5n * 10n ** 18n }) });
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    assert.equal(r.tx, null);
    assert.match(r.refusal, /no longer first/i);
    assert.equal(r.freshCheck.reserveBefore, "5000000000000000000");
  } finally { await s.close(); }
});

test("a market whose code changed since the alert is refused in words", async () => {
  const s = await serve({ check: async () => check({ implNow: "0x0000000000000000000000000000000000000Bad" }) });
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    assert.equal(r.tx, null);
    assert.match(r.refusal, /market code changed/i);
  } finally { await s.close(); }
});

test("a good request becomes one gate.buy with a 98% floor on the fresh quote", async () => {
  const s = await serve();
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    assert.equal(r.refusal, undefined);
    assert.equal(r.tx.to.toLowerCase(), GATE.toLowerCase());
    assert.equal(r.tx.value, (10n ** 17n).toString());
    const d = decodeFunctionData({ abi: GATE_ABI, data: r.tx.data });
    assert.equal(d.functionName, "buy");
    assert.equal(d.args![0], MARKET);
    assert.equal(d.args![1], 980_000n);
    assert.equal(r.setLimits, null, "limits already match, no extra step");
  } finally { await s.close(); }
});

test("without limits on the gate the page gets a setLimits step first", async () => {
  const s = await serve({ readLimits: async () => null });
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    const d = decodeFunctionData({ abi: GATE_ABI, data: r.setLimits.data });
    assert.equal(d.functionName, "setLimits");
  } finally { await s.close(); }
});

test("an unknown request id is a 404", async () => {
  const s = await serve();
  try { assert.equal((await fetch(`${s.base}/api/req/nope`)).status, 404); } finally { await s.close(); }
});

// A signed-in wallet asking from an IP, the way the page does it after Connect Wallet.
const W_A = "0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa";
const W_B = "0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB";
const W_C = "0xcCCccccCcCcCcCCCCccCCcCCCcccCccCCcCcCcCc";
const asker = (s: { base: string; store: ReturnType<typeof openStore> }) => {
  const cookies = new Map<string, string>();
  return (wallet: string | null, ip: string, extra: Record<string, unknown> = {}) => {
    if (wallet && !cookies.has(wallet)) cookies.set(wallet, `${SESSION_COOKIE}=${s.store.newSession(wallet as `0x${string}`, SESSION_TTL_MS)}`);
    return fetch(`${s.base}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": ip, ...(wallet ? { cookie: cookies.get(wallet)! } : {}) },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], env: {}, ...extra }),
    });
  };
};

test("the chat stays closed until a wallet signs in", async () => {
  const s = await serve();
  try {
    const r = await asker(s)(null, "9.9.9.9");
    assert.equal(r.status, 401);
    assert.match((await r.json()).error, /connect your wallet/i);
  } finally { await s.close(); }
});

test("one person's daily limit holds across their wallets and their IPs, and strangers keep theirs", async () => {
  const s = await serve({ userDaily: 2 });
  const ask = asker(s);
  try {
    assert.equal((await ask(W_A, "1.1.1.1")).status, 200);   // phone
    assert.equal((await ask(W_A, "2.2.2.2")).status, 200);   // same wallet at home
    const third = await ask(W_A, "1.1.1.1");
    assert.equal(third.status, 429);
    assert.match((await third.json()).error, /today/i);
    assert.equal((await ask(W_B, "2.2.2.2")).status, 429);   // another wallet from that home IP is the same person
    assert.equal((await ask(W_C, "3.3.3.3")).status, 200);   // somebody else entirely
  } finally { await s.close(); }
});

test("one person gets a few questions a minute, not more", async () => {
  const s = await serve({ perMinute: 2, userDaily: 100 });
  const ask = asker(s);
  try {
    assert.equal((await ask(W_A, "1.1.1.1")).status, 200);
    assert.equal((await ask(W_A, "2.2.2.2")).status, 200);
    const r = await ask(W_A, "1.1.1.1");
    assert.equal(r.status, 429);
    assert.match((await r.json()).error, /minute/i);
  } finally { await s.close(); }
});

test("one question at a time per person", async () => {
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const s = await serve({
    agent: async () => new Response(new ReadableStream({
      start(c) { held.then(() => { c.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); c.close(); }); },
    }), { headers: { "content-type": "text/event-stream" } }),
  });
  const ask = asker(s);
  try {
    const first = await ask(W_A, "1.1.1.1");
    assert.equal(first.status, 200);
    const second = await ask(W_A, "2.2.2.2");
    assert.equal(second.status, 429);
    assert.match((await second.json()).error, /one question at a time/i);
    release();
    await first.text();
    assert.equal((await ask(W_A, "2.2.2.2")).status, 200);
  } finally { release(); await s.close(); }
});

test("the agent is told the signed-in wallet, not whatever address the page sends", async () => {
  let seen: any;
  const s = await serve({ agent: async (_m, env) => { seen = env; return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }); } });
  try {
    await (await asker(s)(W_A, "1.1.1.1", { env: { address: W_B } })).text();
    assert.equal(seen.address, W_A);
  } finally { await s.close(); }
});

test("a question the agent never answered does not count", async () => {
  let down = true;
  const s = await serve({
    userDaily: 1,
    agent: async () => {
      if (down) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8642"), { code: "ECONNREFUSED" });
      return new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    },
  });
  const ask = asker(s);
  try {
    const r = await ask(W_A, "1.1.1.1");
    assert.equal(r.status, 503);
    assert.match((await r.json()).error, /agent unavailable/i);
    assert.equal((await fetch(`${s.base}/api/vault/0x3ed49843a55952a399db99c8949f67a9d821611c`)).status, 200);
    down = false;
    assert.equal((await ask(W_A, "1.1.1.1")).status, 200);
  } finally { await s.close(); }
});

test("the page can ask who is signed in and how many questions are left today", async () => {
  const s = await serve({ userDaily: 5 });
  const ask = asker(s);
  try {
    assert.deepEqual(await (await fetch(`${s.base}/api/me`)).json(), { address: null });
    await (await ask(W_A, "1.1.1.1")).text();
    const cookie = `${SESSION_COOKIE}=${s.store.newSession(W_A, SESSION_TTL_MS)}`;
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie, "x-real-ip": "1.1.1.1" } })).json();
    assert.deepEqual(me, { address: W_A, used: 1, dailyLimit: 5 });
  } finally { await s.close(); }
});

test("the agent's answer lands in the decisions log, the way Hermes really spaces its JSON", async () => {
  const frame = (t: string) => `data: {"choices": [{"index": 0, "delta": {"content": ${JSON.stringify(t)}}}]}\n\n`;
  const s = await serve({ agent: async () => new Response(frame("Backed by ") + frame("\"real\" carry.") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }) });
  try {
    await (await asker(s)(W_A, "1.1.1.1")).text();
    assert.equal(s.store.decisions(5)[0]?.reason, 'Backed by "real" carry.');
  } finally { await s.close(); }
});

test("the vault list is served for the pages", async () => {
  const s = await serve();
  try {
    const r = await (await fetch(`${s.base}/api/vaults`)).json();
    assert.equal(r[0].vaultName, "Barker Neutral Carry");
  } finally { await s.close(); }
});

test("the page can ask whether this copy has a Telegram bot at all", async () => {
  const none = await serve({ telegramBot: () => null });
  const some = await serve({ telegramBot: () => "my_prosperion_bot" });
  try {
    assert.deepEqual(await (await fetch(`${none.base}/api/alerts`)).json(), { bot: null });
    assert.deepEqual(await (await fetch(`${some.base}/api/alerts`)).json(), { bot: "my_prosperion_bot" });
  } finally { await none.close(); await some.close(); }
});

test("no bot, no link codes: the link button says so instead of pointing at a bot nobody runs", async () => {
  const s = await serve({ telegramBot: () => null });
  try {
    const r = await fetch(`${s.base}/api/telegram/link`, { method: "POST" });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /no telegram bot/i);
  } finally { await s.close(); }
});

test("Prepare first buy needs a signed-in wallet and always prepares it for that wallet", async () => {
  const s = await serve();
  try {
    const post = (headers: Record<string, string>, body: unknown) =>
      fetch(`${s.base}/api/prepare`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    const anon = await post({}, { market: MARKET, amountPros: "0.5" });
    assert.equal(anon.status, 401);

    const cookie = `${SESSION_COOKIE}=${s.store.newSession(ME, SESSION_TTL_MS)}`;
    const ok = await post({ cookie }, { market: MARKET, amountPros: "0.5", owner: "0x000000000000000000000000000000000000dEaD" });
    assert.equal(ok.status, 200);
    const r = await ok.json();
    const id = new URL(r.url).searchParams.get("r")!;
    const saved = s.store.getRequest(id)!;
    assert.equal(saved.params.owner, ME);
    assert.equal(saved.params.amountWei, (5n * 10n ** 17n).toString());
    assert.equal(saved.params.source, "page");

    const bad = await post({ cookie }, { market: MARKET, amountPros: "lots" });
    assert.equal(bad.status, 400);
  } finally { await s.close(); }
});

test("Prepare first buy on a market someone already left says why, with no link", async () => {
  const s = await serve({ check: async () => check({ phase: 3 }) });
  try {
    const cookie = `${SESSION_COOKIE}=${s.store.newSession(ME, SESSION_TTL_MS)}`;
    const r = await fetch(`${s.base}/api/prepare`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ market: MARKET, amountPros: "1" }) });
    assert.equal(r.status, 409);
    assert.match((await r.json()).error, /left the curve/);
  } finally { await s.close(); }
});

// The Launches page's "Your buy limits": read what the gate holds for the signed-in wallet, and hand back a
// setLimits transaction for the wallet to sign. The server never sends it.
const limitsCall = (s: { base: string; store: ReturnType<typeof openStore> }, method: string, body?: unknown, signedIn = true) =>
  fetch(`${s.base}/api/limits`, {
    method,
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: `${SESSION_COOKIE}=${s.store.newSession(ME, SESSION_TTL_MS)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const PROS = 10n ** 18n;

test("your limits are read from the gate for the signed-in wallet, with today's spend", async () => {
  const s = await serve({ spentToday: async () => 3n * PROS });
  try {
    assert.equal((await limitsCall(s, "GET", undefined, false)).status, 401);
    const r = await (await limitsCall(s, "GET")).json();
    assert.equal(r.gate.toLowerCase(), GATE.toLowerCase());
    assert.equal(r.limits.maxPerBuy, PROS.toString());
    assert.equal(r.limits.maxPerDay, (10n * PROS).toString());
    assert.equal(r.spentToday, (3n * PROS).toString());
    assert.equal(r.implAccepted, true);
    assert.equal(r.dayEndsAt, 1_800_000_000 - (1_800_000_000 % 86_400) + 86_400);
  } finally { await s.close(); }
});

test("after Prosper upgrades its market code, your limits say they no longer cover it", async () => {
  const s = await serve({ marketImpl: async () => "0x0000000000000000000000000000000000000Bad" });
  try {
    const r = await (await limitsCall(s, "GET")).json();
    assert.equal(r.implAccepted, false);
  } finally { await s.close(); }
});

test("saving limits gives one setLimits tx for the wallet, accepting the market code as it is now", async () => {
  const s = await serve();
  try {
    const res = await limitsCall(s, "POST", { perBuyPros: "0.5", perDayPros: "2", inCurvePros: "0" });
    assert.equal(res.status, 200);
    const r = await res.json();
    assert.equal(r.tx.to.toLowerCase(), GATE.toLowerCase());
    assert.equal(r.tx.value, "0");
    const d = decodeFunctionData({ abi: GATE_ABI, data: r.tx.data });
    assert.equal(d.functionName, "setLimits");
    assert.deepEqual(d.args![0], { maxPerBuy: PROS / 2n, maxPerDay: 2n * PROS, maxReserveBefore: 0n, acceptedMarketImpl: IMPL });
  } finally { await s.close(); }
});

test("limits that cannot work are refused in words", async () => {
  const s = await serve();
  try {
    const dayBelowBuy = await limitsCall(s, "POST", { perBuyPros: "2", perDayPros: "1", inCurvePros: "0" });
    assert.equal(dayBelowBuy.status, 400);
    assert.match((await dayBelowBuy.json()).error, /a day/i);
    assert.equal((await limitsCall(s, "POST", { perBuyPros: "0", perDayPros: "1", inCurvePros: "0" })).status, 400);
    assert.equal((await limitsCall(s, "POST", { perBuyPros: "abc", perDayPros: "1", inCurvePros: "0" })).status, 400);
    assert.equal((await limitsCall(s, "POST", { perBuyPros: "1", perDayPros: "1", inCurvePros: "0" }, false)).status, 401);
  } finally { await s.close(); }
});

test("Stop clears every limit, so the gate refuses any buy from this wallet", async () => {
  const s = await serve();
  try {
    const r = await (await limitsCall(s, "POST", { stop: true })).json();
    const d = decodeFunctionData({ abi: GATE_ABI, data: r.tx.data });
    assert.deepEqual(d.args![0], { maxPerBuy: 0n, maxPerDay: 0n, maxReserveBefore: 0n, acceptedMarketImpl: "0x0000000000000000000000000000000000000000" });
  } finally { await s.close(); }
});

test("a buy link asks to raise the daily limit when today's spend leaves no room", async () => {
  // 1 PROS per buy, 10 a day, 9.95 already spent today: the 0.1 buy would revert with OverPerDay
  const s = await serve({ spentToday: async () => 9_950n * 10n ** 15n });
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    assert.ok(r.setLimits, "the page needs a setLimits step first");
    assert.ok(BigInt(r.setLimits.limits.maxPerDay) >= 9_950n * 10n ** 15n + 10n ** 17n);
  } finally { await s.close(); }
});

test("a buy link never lowers limits you set higher yourself", async () => {
  // your own 0.05 per buy is too small for the 0.1 buy, but your 10 a day must stay 10, not drop to 0.3
  const s = await serve({ readLimits: async () => ({ maxPerBuy: 5n * 10n ** 16n, maxPerDay: 10n * PROS, maxReserveBefore: 2n * PROS, acceptedMarketImpl: IMPL }) });
  try {
    const r = await (await fetch(`${s.base}/api/req/${buyRequest(s.store)}`)).json();
    assert.equal(r.setLimits.limits.maxPerBuy, (10n ** 17n).toString());
    assert.equal(r.setLimits.limits.maxPerDay, (10n * PROS).toString());
    assert.equal(r.setLimits.limits.maxReserveBefore, (2n * PROS).toString());
  } finally { await s.close(); }
});
