import { test } from "node:test";
import assert from "node:assert/strict";
import type { Card } from "./cards.js";
import { discordEmbed, localTime, makeNotifier, telegramHtml } from "./notify.js";

const PETE = "0x1111111111111111111111111111111111111111" as const;
const TX = ("0x" + "ab".repeat(32)) as `0x${string}`;
const paid: Card = { kind: "paid", label: "Payroll", series: "payroll", period: 2, token: "USDC", tz: "Europe/Moscow", at: "2026-11-27T06:00:20.000Z", lines: [{ name: "Pete <3", address: PETE, amount: "0.1", tx: TX }] };
const short: Card = { kind: "short", label: "Payroll", series: "payroll", period: 2, token: "USDC", tz: "UTC", due: "2026-11-27T09:00:00.000Z", name: "Anna", amount: "0.05", need: "0.05", have: "0.02", asset: "USDC", wallet: PETE };

test("local time is the series' wall clock with the zone named", () => {
  assert.equal(localTime("2026-11-27T06:00:20.000Z", "Europe/Moscow"), "Fri 27 Nov 2026, 09:00 (Europe/Moscow)");
});

test("a paid card says who, how much, when and links the transaction", () => {
  const t = telegramHtml(paid);
  assert.ok(t.includes("<b>Payroll</b>"));
  assert.ok(t.includes("payment #3"));
  assert.ok(t.includes("Pete &lt;3"));
  assert.ok(t.includes("0.1 USDC"));
  assert.ok(t.includes("0x1111…1111"));
  assert.ok(t.includes(`https://www.pharosscan.xyz/tx/${TX}`));
  assert.ok(t.includes("Fri 27 Nov 2026, 09:00 (Europe/Moscow)"));
  const d = discordEmbed(paid) as { title: string; description: string; color: number };
  assert.ok(d.title.includes("Payroll"));
  assert.ok(d.description.includes(`(https://www.pharosscan.xyz/tx/${TX})`));
});

test("a short card says what is needed, what there is and where to top up", () => {
  const t = telegramHtml(short);
  assert.ok(t.includes("needs 0.05 USDC"));
  assert.ok(t.includes("has 0.02"));
  assert.ok(t.includes(PETE));
  assert.ok(/only once/.test(t));
});

test("no channel configured: cards are dropped quietly and the notifier says so", async () => {
  const n = makeNotifier({}, (async () => new Response("{}")) as typeof fetch);
  assert.deepEqual(n.channels, []);
  await n.send(paid);
});

test("a failing channel throws without ever printing the bot token", async () => {
  const token = "123456:SECRETSECRETSECRET";
  const net = (async () => new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${token}` }), { status: 401 })) as typeof fetch;
  const n = makeNotifier({ telegramToken: token, telegramChatId: "42" }, net);
  await assert.rejects(n.send(paid), (e: Error) => !e.message.includes("SECRET"));
});

test("one channel up, one down: the card counts as delivered", async () => {
  const calls: string[] = [];
  const net = (async (url: string | URL) => {
    calls.push(String(url));
    if (String(url).includes("telegram")) return new Response(JSON.stringify({ ok: true, result: {} }));
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  const n = makeNotifier({ telegramToken: "1:x", telegramChatId: "42", discordWebhook: "https://discord.com/api/webhooks/1/abc" }, net);
  await n.send(paid);
  assert.equal(calls.length, 2);
});
