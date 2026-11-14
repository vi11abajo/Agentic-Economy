import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData } from "viem";
import { createApi, GATE_ABI, type ApiDeps } from "./api.js";
import { openStore } from "./store.js";
import { SESSION_COOKIE, SESSION_TTL_MS } from "./auth.js";
import type { MarketCheck } from "./market.js";
import QRCode from "qrcode";
import { requestUrl, walletLinks } from "./links.js";

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
  return { base, store: deps.store, close: () => new Promise<void>((r) => http.close(() => r())) };
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

test("a saved sign link has a QR code a phone wallet can scan; an unknown one has none", async () => {
  const s = await serve();
  try {
    const id = buyRequest(s.store);
    const qr = await fetch(`${s.base}/api/req/${id}/qr.svg`);
    assert.equal(qr.status, 200);
    assert.equal(qr.headers.get("content-type"), "image/svg+xml");
    assert.match(await qr.text(), /^<svg[^>]*viewBox/);
    assert.equal((await fetch(`${s.base}/api/req/nope/qr.svg`)).status, 404);
  } finally { await s.close(); }
});

test("the QR can carry a wallet's own link, so a phone camera opens the page straight inside that wallet", async () => {
  const s = await serve();
  try {
    const id = buyRequest(s.store);
    const page = requestUrl(id);
    // what each QR holds, read back by drawing the expected text the same way and comparing the pictures
    const drawn = (text: string) => QRCode.toString(text, { type: "svg", errorCorrectionLevel: "M", margin: 2 });
    const got = async (q: string) => (await fetch(`${s.base}/api/req/${id}/qr.svg${q}`)).text();
    const l = walletLinks(page);
    assert.equal(await got("?wallet=rabby"), await drawn(l.rabby));
    assert.equal(await got("?wallet=okx"), await drawn(l.okx));
    assert.equal(await got("?wallet=metamask"), await drawn(l.metamask));
    assert.equal(await got(""), await drawn(page), "no wallet named: the plain page, as before");
    assert.equal((await fetch(`${s.base}/api/req/${id}/qr.svg?wallet=phantom`)).status, 400);
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
    // the market code stays in, so the gate can tell "stopped" from "never set" and no buy link offers limits again
    assert.deepEqual(d.args![0], { maxPerBuy: 0n, maxPerDay: 0n, maxReserveBefore: 0n, acceptedMarketImpl: IMPL });
  } finally { await s.close(); }
});

// Limits are yours. A buy link only ever offers to set them when the gate has none; once set, a buy that does not fit
// is refused in words and the page points to "Your buy limits". (It used to raise them to fit, so a 0.1 limit became
// 10 with one more signature.)
const refusedFor = async (over: Partial<ApiDeps>, maxReserveBeforeWei = "0") => {
  const s = await serve(over);
  try { return await (await fetch(`${s.base}/api/req/${buyRequest(s.store, maxReserveBeforeWei)}`)).json(); }
  finally { await s.close(); }
};

test("a buy above your per-buy limit is refused, never raised", async () => {
  const r = await refusedFor({ readLimits: async () => ({ maxPerBuy: 5n * 10n ** 16n, maxPerDay: 10n * PROS, maxReserveBefore: 2n * PROS, acceptedMarketImpl: IMPL }) });
  assert.match(r.refusal, /above your limit of 0\.05 PROS per buy/);
  assert.match(r.refusal, /Your buy limits/);
  assert.equal(r.setLimits, null);
  assert.equal(r.tx, null);
});

test("a buy that does not fit in what is left of today is refused", async () => {
  // 1 PROS per buy, 10 a day, 9.95 already spent today: the 0.1 buy would revert with OverPerDay
  const r = await refusedFor({ spentToday: async () => 9_950n * 10n ** 15n });
  assert.match(r.refusal, /0\.05 PROS is left of your 10 PROS a day/);
  assert.equal(r.tx, null);
});

test("more PROS in the curve than your limit allows is refused, even when the link itself would allow it", async () => {
  const r = await refusedFor({ check: async () => check({ reserveBefore: 5n * PROS }) }, (10n * PROS).toString());
  assert.match(r.refusal, /only while at most 0 PROS is in the curve; 5 PROS is in it now/);
  assert.equal(r.tx, null);
});

test("after Stop all buys a buy link is refused instead of offering new limits", async () => {
  const r = await refusedFor({ readLimits: async () => ({ maxPerBuy: 0n, maxPerDay: 0n, maxReserveBefore: 0n, acceptedMarketImpl: IMPL }) });
  assert.match(r.refusal, /stopped all buys/);
  assert.equal(r.setLimits, null);
  assert.equal(r.tx, null);
});

test("limits that accepted older market code are refused with a pointer to save them again", async () => {
  const r = await refusedFor({ readLimits: async () => ({ maxPerBuy: PROS, maxPerDay: 10n * PROS, maxReserveBefore: 0n, acceptedMarketImpl: "0x1111111111111111111111111111111111111111" }) });
  assert.match(r.refusal, /market code changed since you set your limits/);
  assert.equal(r.tx, null);
});

test("Sign out ends the session on the server and clears the cookie, so another wallet can connect", async () => {
  const s = await serve();
  try {
    const token = s.store.newSession(ME, SESSION_TTL_MS);
    const cookie = `${SESSION_COOKIE}=${token}`;
    const out = await fetch(`${s.base}/api/signout`, { method: "POST", headers: { cookie } });
    assert.equal(out.status, 200);
    assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`^${SESSION_COOKIE}=;.*Max-Age=0`));
    assert.equal(s.store.sessionAddress(token), null, "the old token is dead even if a browser keeps sending it");
    const me = await (await fetch(`${s.base}/api/me`, { headers: { cookie } })).json();
    assert.equal(me.address, null);
    // signing out with no session is fine too
    assert.equal((await fetch(`${s.base}/api/signout`, { method: "POST" })).status, 200);
  } finally { await s.close(); }
});

test("the Launches list re-checks markets still on the curve before it answers", async () => {
  const s = await serve({ check: async () => check({ block: 777n, reserveBefore: 18_909n * 10n ** 15n }) });
  try {
    s.store.saveLaunch({ market: MARKET, vault: "0x251a68B711EA3967B434EefCA49D43cD133Ef3ee", pToken: "0x14C150c0D60006d0CDdDcA860bA7C50F180baf81", block: 90n, tx: "0xabc", checks: check() });
    const [l] = await (await fetch(`${s.base}/api/launches`)).json();
    assert.equal(l.checks.reserveBefore, (18_909n * 10n ** 15n).toString());
    assert.equal(l.checks.block, "777");
  } finally { await s.close(); }
});

// ---- the shared bot's settings
const alertsCall = (s: { base: string; store: ReturnType<typeof openStore> }, path: string, method = "GET", body?: unknown, signedIn = true) =>
  fetch(`${s.base}/api${path}`, {
    method,
    headers: { "content-type": "application/json", ...(signedIn ? { cookie: `${SESSION_COOKIE}=${s.store.newSession(ME, SESSION_TTL_MS)}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

test("alert settings: saved per wallet, checked kind by kind, and only for the signed-in wallet", async () => {
  const { openAlertBook } = await import("./subscriptions.js");
  const store = openStore(":memory:");
  const s = await serve({ store, alerts: openAlertBook(store.db), telegramBot: () => "prospeMonitor_bot" });
  try {
    const before = await (await alertsCall(s, "/alerts")).json();
    assert.equal(before.bot, "prospeMonitor_bot");
    assert.equal(before.me.linked, false);
    assert.equal(before.me.subs.snipe.on, false);
    const saved = await alertsCall(s, "/alerts/subs", "POST", { snipe: { on: true, amountPros: "0.5", maxInCurvePros: "0" }, security: { on: true } });
    assert.equal(saved.status, 200);
    const after = await (await alertsCall(s, "/alerts")).json();
    assert.equal(after.me.subs.snipe.amountPros, "0.5");
    assert.equal(after.me.subs.security.on, true);
    const bad = await alertsCall(s, "/alerts/subs", "POST", { digest: { on: true, hourUtc: 30 } });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /digest/);
    assert.equal((await alertsCall(s, "/alerts/subs", "POST", {}, false)).status, 401);
    const link = await alertsCall(s, "/telegram/link", "POST");
    assert.equal(link.status, 200, "linking no longer needs a launch watch saved first");
    assert.match((await link.json()).code, /^[0-9a-f]{12}$/);
  } finally { await s.close(); }
});

test("a sell link is re-read on open: approve only when needed, refused when the wallet holds less now", async () => {
  const PT = "0x05457dA2c193ce92C1877ec2B9eA3966bD54fafE" as const;
  let held = 10n ** 21n, allowance = 0n;
  const s = await serve({
    readSell: async (market, _owner, pick) => {
      const amount = pick(held, 18);
      return {
        market, block: 200n, genuine: true, phase: 0, pToken: PT, symbol: "pANTA", decimals: 18, balance: held, allowance, amount,
        quote: amount <= held ? { gross: 10n ** 17n, fee: 10n ** 15n, net: 99n * 10n ** 15n } : null,
      };
    },
  });
  try {
    const id = s.store.saveRequest({ kind: "sell", createdBlock: 190n, params: { market: MARKET, owner: ME, pToken: PT, symbol: "pANTA", amountTokens: "500", minOutBps: 9800, source: "agent" } });
    const r = await (await fetch(`${s.base}/api/req/${id}`)).json();
    assert.equal(r.refusal, undefined);
    assert.equal(r.approve.to, PT);
    assert.equal(r.sell.amount, (500n * 10n ** 18n).toString());
    assert.equal(r.tx.minOut, ((99n * 10n ** 15n * 9800n) / 10_000n).toString());
    allowance = 10n ** 21n;
    const again = await (await fetch(`${s.base}/api/req/${id}`)).json();
    assert.equal(again.approve, null, "the router may already take them");
    held = 10n ** 20n;
    const less = await (await fetch(`${s.base}/api/req/${id}`)).json();
    assert.match(less.refusal, /more than the wallet holds: 100 pANTA/);
    assert.equal(less.tx, undefined);
  } finally { await s.close(); }
});
