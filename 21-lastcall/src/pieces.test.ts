// The smaller parts: Morpho's id check and interest maths, decoding the admin events, and delivery with a fake
// network (no real Telegram or Discord gets called here).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Hex } from "viem";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ENV_TEMPLATE, channelsOn, ensureEnvTemplate, hide, loadSecrets, shout, type Outlet } from "./deliver.js";
import { idMatchesParams, taylor } from "./morpho.js";
import type { Card } from "./render.js";
import { decodeRuleLog, isRuleChange } from "./tripwire.js";

// The real syzUSD/USDC market, params as idToMarketParams returned them on 2026-11-06.
const SYZ_ID: Hex = "0xc79579a002dbc8c535d3a87198fcbbece1a664ad82a356b0447c5bff9e16fd86";
const SYZ = {
  loanToken: "0xc879c018db60520f4355c26ed1a6d572cdac1815",
  collateralToken: "0x54df79d8edf36d15cd83fbedbdd90807fc828934",
  oracle: "0x4eefc4c6e7216aedd5e809e4fc74fb8859b3fa46",
  irm: "0xd5e02889c13230458506cc842347c4e62f8cdf3a",
  lltv: 915000000000000000n,
} as const;

test("a Morpho market id is the hash of its params, so its terms can't change", () => {
  assert.equal(idMatchesParams(SYZ_ID, SYZ), true);
  assert.equal(idMatchesParams(SYZ_ID, { ...SYZ, lltv: 860000000000000000n }), false);
});

test("Taylor compounding matches e^x - 1 for a year at 5.9%", () => {
  const perSecond = BigInt(Math.round((0.0591 / 31_536_000) * 1e18));
  const grown = Number(taylor(perSecond, 31_536_000n)) / 1e18;
  assert.ok(Math.abs(grown - (Math.exp(0.0591) - 1)) < 1e-5, String(grown));
});

test("the Avalon strategy swap decodes as a rule change, Safe paperwork doesn't", () => {
  // Two logs from tx 0x1e75012b...7ac5, block 22302862.
  const strategy = decodeRuleLog({
    address: "0x4bbd637d772c23a6f12498e7520797f45d747012",
    topics: ["0xdb8dada53709ce4988154324196790c2e4a60c377e1256790946f83b87db3c33", "0x000000000000000000000000c879c018db60520f4355c26ed1a6d572cdac1815"],
    data: "0x", blockNumber: 22302862, transactionHash: "0x1e75012b9c68679ba99621a719a3e77f0f6a59de2cfc119c8975d144c4f97ac5", logIndex: 1,
  });
  assert.equal(strategy.name, "ReserveInterestRateStrategyChanged");
  assert.equal(strategy.subject, "0xc879c018db60520f4355c26ed1a6d572cdac1815");
  assert.equal(isRuleChange(strategy), true);
  const done = decodeRuleLog({
    address: "0xc6f56760f2f4e41095db8269c5d8380b0fd184f4",
    topics: ["0x442e715f626346e8c54381002da614f62bee8d27386535b2521ec8540898556e"],
    data: "0x", blockNumber: 22302862, transactionHash: "0x1e75012b9c68679ba99621a719a3e77f0f6a59de2cfc119c8975d144c4f97ac5", logIndex: 9,
  });
  assert.equal(done.name, "ExecutionSuccess");
  assert.equal(isRuleChange(done), false);
});

test("secrets never show up in what we print", () => {
  const s = { telegramToken: "123456:ABCDEF-secret", discordWebhook: "https://discord.com/api/webhooks/1/hookSecretPart" };
  const t = hide("POST https://api.telegram.org/bot123456:ABCDEF-secret/x and https://discord.com/api/webhooks/1/hookSecretPart failed", s);
  assert.ok(!t.includes("ABCDEF") && !t.includes("hookSecretPart"), t);
});

test("an alert goes to the console with a timestamp and to both channels", async () => {
  const lines: string[] = [];
  const calls: string[] = [];
  const net = (async (url: string, init: { body: string }) => {
    calls.push(`${url.includes("telegram") ? "telegram" : "discord"} ${JSON.parse(init.body).text ?? JSON.parse(init.body).content}`);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const o: Outlet = { console: (l) => lines.push(l), net, secrets: { telegramToken: "t0ken:x", telegramChat: "42", discordWebhook: "https://d/1/w" }, telegram: true, discord: true };
  const report = await shout(o, "CRITICAL something\nact: repay 1 USDC", new Date("2026-11-06T12:00:00Z"));
  assert.match(lines[0], /^\[2026-11-06T12:00:00.000Z\] CRITICAL something/);
  assert.match(lines[0], /\n\s+act: repay 1 USDC/);
  assert.deepEqual(report, ["telegram: delivered", "discord: delivered"]);
  assert.ok(calls.every((c) => c.includes("[2026-11-06T12:00:00.000Z] CRITICAL")));
});

test("with a card, Discord gets a coloured embed and Telegram gets HTML, the console still gets the text", async () => {
  const bodies: Record<string, any> = {};
  const net = (async (url: string, init: { body: string }) => {
    bodies[url.includes("telegram") ? "telegram" : "discord"] = JSON.parse(init.body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }) as unknown as typeof fetch;
  const lines: string[] = [];
  const o: Outlet = { console: (l) => lines.push(l), net, secrets: { telegramToken: "t0ken:x", telegramChat: "42", discordWebhook: "https://d/1/w" }, telegram: true, discord: true };
  const card: Card = { tone: "critical", title: "CRITICAL · Avalon", lead: "health 1.05 <below warn>", fields: [{ name: "To do", value: "repay 1 USDC" }], footer: "lastcall · Pharos block 1" };
  await shout(o, "CRITICAL something", new Date("2026-11-06T12:00:00Z"), card);
  assert.match(lines[0], /CRITICAL something/);
  const e = bodies.discord.embeds[0];
  assert.equal(e.color, 0xdc2626);
  assert.deepEqual(e.fields, [{ name: "To do", value: "repay 1 USDC", inline: false }]);
  assert.equal(e.timestamp, "2026-11-06T12:00:00.000Z");
  assert.equal(bodies.telegram.parse_mode, "HTML");
  assert.match(bodies.telegram.text, /^<b>CRITICAL · Avalon<\/b>/);
  assert.ok(bodies.telegram.text.includes("&lt;below warn&gt;"), "card text is escaped for Telegram HTML");
});

test("a channel that isn't set up says so instead of failing silently", async () => {
  const o: Outlet = { console: () => {}, net: fetch, secrets: {}, telegram: true, discord: true };
  assert.deepEqual(await shout(o, "x"), ["telegram: not set up (token or chat id missing)", "discord: not set up (webhook missing)"]);
});

test("the alerts file: empty template means console only, filled lines switch channels on", () => {
  const dir = mkdtempSync(join(tmpdir(), "lastcall-"));
  const p = ensureEnvTemplate(dir);
  assert.deepEqual(channelsOn(loadSecrets(dir)), { telegram: false, discord: false });
  // Only the token: Telegram stays off until the chat id is found.
  writeFileSync(p, ENV_TEMPLATE.replace("LASTCALL_TELEGRAM_BOT_TOKEN=", "LASTCALL_TELEGRAM_BOT_TOKEN=123:abc"));
  assert.deepEqual(channelsOn(loadSecrets(dir)), { telegram: false, discord: false });
  writeFileSync(p, ENV_TEMPLATE.replace("LASTCALL_TELEGRAM_BOT_TOKEN=", "LASTCALL_TELEGRAM_BOT_TOKEN=123:abc").replace("LASTCALL_TELEGRAM_CHAT_ID=", "LASTCALL_TELEGRAM_CHAT_ID=42").replace("LASTCALL_DISCORD_WEBHOOK=", "LASTCALL_DISCORD_WEBHOOK=https://discord.com/api/webhooks/1/x"));
  assert.deepEqual(channelsOn(loadSecrets(dir)), { telegram: true, discord: true });
  ensureEnvTemplate(dir);
  assert.equal(loadSecrets(dir).telegramChat, "42", "a filled file is never overwritten");
});
