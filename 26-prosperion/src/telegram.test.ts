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

test("an alert with buttons is HTML with an inline keyboard; a snipe is the QR with wallet buttons first", async () => {
  const calls: { method: string; body: any }[] = [];
  const tg = telegramChannel("TOKEN", fakeFetch(calls));
  await tg.send({ chatId: 7, html: "<b>x</b>", buttons: [[{ text: "Follow", data: "follow:0x1" }, { text: "Launches", url: "https://prosperion.pharosfdv.xyz/launches/" }]], replyTo: 3 });
  assert.equal(calls[0].body.parse_mode, "HTML");
  assert.deepEqual(calls[0].body.reply_markup.inline_keyboard[0][0], { text: "Follow", callback_data: "follow:0x1" });
  assert.equal(calls[0].body.reply_parameters.message_id, 3);
  await tg.send({ chatId: 7, html: "snipe", sign: { url: "https://prosperion.pharosfdv.xyz/sign/?r=abc" }, buttons: [[{ text: "Mute this market", data: "mute:0x1" }]] });
  assert.equal(calls[1].method, "sendPhoto");
  const kb = JSON.parse(String((calls[1].body as FormData).get("reply_markup"))).inline_keyboard;
  assert.equal(kb[0][0].text, "Open in OKX");
  assert.equal(kb.at(-1)[0].callback_data, "mute:0x1");
});

test("commands work for the wallets linked to this chat only; buttons follow and mute", async () => {
  const { openAlertBook } = await import("./subscriptions.js");
  const store = openStore(":memory:");
  const book = openAlertBook(store.db);
  const me = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
  const market = "0xBB3DC336E9221be62cc63e62E3969580B5BAB82c";
  const calls: { method: string; body: any }[] = [];
  const tg = telegramChannel("TOKEN", fakeFetch(calls));
  const say = async (text: string, chat = 5) => { await handleUpdate({ message: { chat: { id: chat }, text } }, store, tg, book); return calls.at(-1)!.body.text as string; };

  assert.match(await say("/status"), /not linked/);
  await handleUpdate({ message: { chat: { id: 5 }, text: `/start ${store.newLinkCode(me)}` } }, store, tg, book);
  assert.match(await say("/status"), /nothing switched on yet/);
  assert.match(await say("/pause 6h"), /Quiet until/);
  assert.ok(book.pausedUntil(me));
  await say("/resume");
  assert.equal(book.pausedUntil(me), null);
  await say(`/follow ${market}`);
  assert.deepEqual(book.follows(me), [market]);
  assert.match(await say("/pause forever"), /Say how long/);

  await handleUpdate({ callback_query: { id: "q1", data: `mute:${market}`, message: { chat: { id: 5 } } } }, store, tg, book);
  assert.equal(book.isMuted(me, market), true);
  assert.match(calls.at(-1)!.body.text, /Muted/);
  await handleUpdate({ callback_query: { id: "q2", data: `mute:${market}`, message: { chat: { id: 999 } } } }, store, tg, book);
  assert.match(calls.at(-1)!.body.text, /not linked/, "a stranger's chat cannot mute anything for this wallet");

  assert.match(await say("/unlink"), /Unlinked/);
  assert.deepEqual(book.addressesOfChat(5), []);
});
