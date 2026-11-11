import { test } from "node:test";
import assert from "node:assert/strict";
import { telegramChannel, handleUpdate } from "./telegram.js";
import { walletLinks } from "./links.js";
import { openStore } from "./store.js";

function fakeFetch(calls: { method: string; body: any }[]) {
  return (async (url: string, init: RequestInit) => {
    const method = String(url).split("/").pop()!;
    const body = init.body instanceof FormData ? init.body : JSON.parse(String(init.body));
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: { message_id: 55 } }));
  }) as unknown as typeof fetch;
}

test("wave one is a QR photo with https-only wallet buttons", async () => {
  const calls: { method: string; body: any }[] = [];
  const tg = telegramChannel("TOKEN", fakeFetch(calls));
  const url = "https://prosperion.pharosfdv.xyz/sign/?r=abc";
  const id = await tg.sendWave1(7, "<b>facts</b>", { url, links: walletLinks(url) });
  assert.equal(id, 55);
  assert.equal(calls[0].method, "sendPhoto");
  const form = calls[0].body as FormData;
  assert.equal(form.get("chat_id"), "7");
  assert.ok(form.get("photo") instanceof Blob);
  const kb = JSON.parse(String(form.get("reply_markup"))).inline_keyboard.flat();
  assert.ok(kb.length >= 4);
  assert.ok(kb.every((b: { url: string }) => b.url.startsWith("https://")), "Telegram only allows https buttons");
});

test("wave two replies to wave one", async () => {
  const calls: { method: string; body: any }[] = [];
  const tg = telegramChannel("TOKEN", fakeFetch(calls));
  await tg.sendWave2(7, 55, "dossier");
  assert.equal(calls[0].method, "sendMessage");
  assert.equal(calls[0].body.reply_parameters.message_id, 55);
});

test("/start with a fresh code links the chat to the signed-in address", async () => {
  const store = openStore(":memory:");
  const me = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
  store.upsertWatch({ address: me, maxPerBuyWei: 1n, maxReserveBeforeWei: 0n, curatorDeny: [] });
  const code = store.newLinkCode(me);
  const calls: { method: string; body: any }[] = [];
  const tg = telegramChannel("TOKEN", fakeFetch(calls));
  await handleUpdate({ message: { chat: { id: 31337 }, text: `/start ${code}` } }, store, tg);
  assert.equal(store.watchesFor(me)[0].telegramChatId, 31337);
  assert.match(calls[0].body.text, /linked/i);
  await handleUpdate({ message: { chat: { id: 1 }, text: `/start ${code}` } }, store, tg);
  assert.match(calls[1].body.text, /expired|used/i);
});
