import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJournal, homeDir, initHome, loadPeople, loadSeries, readJournal, readSecrets, savePeople, saveSeries, type Series } from "./store.js";

const KEY_A = ("0x" + "11".repeat(32)) as `0x${string}`;
const KEY_B = ("0x" + "22".repeat(32)) as `0x${string}`;
const fresh = () => mkdtempSync(join(tmpdir(), "bookkeeper-"));

test("home folder: BOOKKEEPER_HOME wins, then APPDATA on Windows, then ~/.config", () => {
  assert.equal(homeDir({ BOOKKEEPER_HOME: "X:/h" }, "win32"), "X:/h");
  assert.equal(homeDir({ APPDATA: "C:/Users/u/AppData/Roaming" }, "win32"), join("C:/Users/u/AppData/Roaming", "bookkeeper"));
  assert.equal(homeDir({ XDG_CONFIG_HOME: "/x" }, "linux"), join("/x", "bookkeeper"));
});

test("init writes a key once and never replaces it", () => {
  const h = fresh();
  const one = initHome(h, () => KEY_A);
  const two = initHome(h, () => KEY_B);
  assert.equal(one.created, true);
  assert.equal(two.created, false);
  assert.equal(one.address, two.address);
  assert.equal(readSecrets(h).privateKey, KEY_A);
  const env = readFileSync(join(h, ".env"), "utf8");
  assert.ok(env.includes("BOOKKEEPER_TELEGRAM_BOT_TOKEN="));
  assert.ok(!env.includes(KEY_B));
});

test("a key the user pasted with quotes and CRLF is read", () => {
  const h = fresh();
  writeFileSync(join(h, ".env"), `BOOKKEEPER_PRIVATE_KEY="${KEY_B}"\r\nBOOKKEEPER_DISCORD_WEBHOOK=https://discord.com/api/webhooks/1/abc\r\n`);
  const s = readSecrets(h);
  assert.equal(s.privateKey, KEY_B);
  assert.equal(s.discordWebhook, "https://discord.com/api/webhooks/1/abc");
  assert.equal(s.telegramToken, undefined);
  assert.equal(initHome(h, () => KEY_A).created, false);
});

test("a key without 0x is accepted, garbage is not", () => {
  const h = fresh();
  writeFileSync(join(h, ".env"), `BOOKKEEPER_PRIVATE_KEY=${"33".repeat(32)}\n`);
  assert.equal(readSecrets(h).privateKey, "0x" + "33".repeat(32));
  writeFileSync(join(h, ".env"), `BOOKKEEPER_PRIVATE_KEY=nope\n`);
  assert.throws(() => readSecrets(h), /BOOKKEEPER_PRIVATE_KEY/);
});

test("journal keeps every event and skips a line torn by a crash", () => {
  const h = fresh();
  appendJournal(h, { at: "2026-11-10T10:00:00Z", series: "s1", period: 0, payee: 0, kind: "due" });
  appendJournal(h, { at: "2026-11-10T10:00:01Z", series: "s1", period: 0, payee: 0, kind: "paid", tx: "0xabc" });
  appendFileSync(join(h, "journal.jsonl"), '{"at":"2026-11-10T10:0');
  const j = readJournal(h);
  assert.equal(j.length, 2);
  assert.equal(j[1].tx, "0xabc");
});

test("series and people round-trip", () => {
  const h = fresh();
  assert.deepEqual(loadSeries(h), []);
  const s: Series = { id: "payroll", label: "Payroll", token: "USDC", payees: [{ name: "Pete", address: "0x000000000000000000000000000000000000dEaD", amount: "50" }], every: { n: 1, unit: "week" }, first: "2026-11-13T09:00", tz: "UTC", checkEveryMinutes: 1440, status: "active", approvedAt: "2026-11-10T10:00:00Z", planId: "abc" };
  saveSeries(h, [s]);
  assert.deepEqual(loadSeries(h), [s]);
  savePeople(h, { Pete: "0x000000000000000000000000000000000000dEaD" });
  assert.equal(loadPeople(h).Pete, "0x000000000000000000000000000000000000dEaD");
});
