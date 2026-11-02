import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DeliveryError, findTelegramChat, redact, sendDiscord, sendTelegram, withRetry, type Net } from "./deliver.js";

type Call = { url: string; init?: RequestInit };
function fakeNet(answer: (c: Call) => { status: number; body: unknown } | Error): Net & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c = { url: String(url), init };
    calls.push(c);
    const a = answer(c);
    if (a instanceof Error) throw a;
    return new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  }) as Net & { calls: Call[] };
  f.calls = calls;
  return f;
}
const ok = { status: 200, body: { ok: true, result: {} } };
const S = { telegramToken: "123:abc", telegramChatId: "42", discordWebhook: "https://discord.com/api/webhooks/1/secrettoken" };

describe("telegram", () => {
  it("sends the message then the report file", async () => {
    const net = fakeNet(() => ok);
    await sendTelegram(net, S, "<b>hi</b>", { name: "r.html", body: "<html>" });
    assert.equal(net.calls[0].url, "https://api.telegram.org/bot123:abc/sendMessage");
    const body = JSON.parse(String(net.calls[0].init!.body));
    assert.deepEqual([body.chat_id, body.parse_mode, body.text], ["42", "HTML", "<b>hi</b>"]);
    assert.equal(net.calls[1].url, "https://api.telegram.org/bot123:abc/sendDocument");
    assert.ok(net.calls[1].init!.body instanceof FormData);
  });

  it("finds the chat of the newest /start", async () => {
    const net = fakeNet(() => ({ status: 200, body: { ok: true, result: [
      { message: { text: "/start", chat: { id: 1 } } },
      { message: { text: "hello", chat: { id: 2 } } },
      { message: { text: "/start", chat: { id: 3 } } },
      { message: { text: "later", chat: { id: 4 } } },
    ] } }));
    assert.equal(await findTelegramChat(net, "123:abc"), "3");
  });

  it("explains a wrong token and a chat that never started the bot", async () => {
    await assert.rejects(sendTelegram(fakeNet(() => ({ status: 401, body: { ok: false, description: "Unauthorized" } })), S, "x"), (e: DeliveryError) => /token is wrong/.test(e.hint));
    await assert.rejects(sendTelegram(fakeNet(() => ({ status: 400, body: { ok: false, description: "Bad Request: chat not found" } })), S, "x"), (e: DeliveryError) => /\/start/.test(e.hint));
  });

  it("never shows the token in an error, even when fetch puts the URL in its message", async () => {
    const net = fakeNet(() => new TypeError("fetch failed: https://api.telegram.org/bot123:abc/sendMessage"));
    await assert.rejects(sendTelegram(net, S, "x"), (e: Error) => !e.message.includes("123:abc") && !String((e as DeliveryError).hint).includes("123:abc"));
  });
});

describe("discord", () => {
  it("posts the payload and the file to the webhook and waits for the message", async () => {
    const net = fakeNet(() => ({ status: 200, body: { id: "9" } }));
    await sendDiscord(net, S.discordWebhook, { username: "Prosper Weekly" }, { name: "r.html", body: "<html>" });
    assert.equal(net.calls[0].url, `${S.discordWebhook}?wait=true`);
    const form = net.calls[0].init!.body as FormData;
    assert.equal(JSON.parse(String(form.get("payload_json"))).username, "Prosper Weekly");
    assert.ok(form.get("files[0]"));
  });

  it("explains a deleted webhook without printing it", async () => {
    const net = fakeNet(() => ({ status: 404, body: { message: "Unknown Webhook" } }));
    await assert.rejects(sendDiscord(net, S.discordWebhook, {}), (e: DeliveryError) => /deleted/.test(e.hint) && !e.message.includes("secrettoken"));
  });
});

describe("helpers", () => {
  it("redacts the token, the webhook and its secret part", () => {
    const r = redact("a https://discord.com/api/webhooks/1/secrettoken b bot123:abc c secrettoken", S);
    assert.ok(!r.includes("secrettoken") && !r.includes("123:abc"), r);
  });

  it("retries with the given delays and stops on success", async () => {
    const waits: number[] = [];
    let n = 0;
    const v = await withRetry(async () => { if (++n < 3) throw new Error("no"); return n; }, { delaysMs: [5, 7, 9], sleep: async (ms) => { waits.push(ms); } });
    assert.equal(v, 3);
    assert.deepEqual(waits, [5, 7]);
  });
});
