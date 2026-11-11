import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { decodeFunctionData } from "viem";
import { createApi, GATE_ABI, type ApiDeps } from "./api.js";
import { openStore } from "./store.js";
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
    readVault: async () => ({ ok: true }),
    listVaults: async () => [{ vaultName: "Barker Neutral Carry", r25Vault: "0x3ed49843a55952a399db99c8949f67a9d821611c" }],
    explainNavMove: async () => ({ ok: true }),
    agent: async () => new Response("data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n\ndata: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
    telegramBot: () => null,
    perMinute: 20,
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

test("the open chat stops one IP after 20 messages a minute", async () => {
  const s = await serve();
  try {
    const send = () => fetch(`${s.base}/api/chat`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "9.9.9.9" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], env: {} }) });
    for (let i = 0; i < 20; i++) assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 429);
  } finally { await s.close(); }
});

test("with the agent down, chat says so and the chain pages keep working", async () => {
  const s = await serve({ agent: async () => { throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:8642"), { code: "ECONNREFUSED" }); } });
  try {
    const chat = await fetch(`${s.base}/api/chat`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], env: {} }) });
    assert.equal(chat.status, 503);
    assert.match((await chat.json()).error, /agent unavailable/i);
    assert.equal((await fetch(`${s.base}/api/vault/0x3ed49843a55952a399db99c8949f67a9d821611c`)).status, 200);
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
