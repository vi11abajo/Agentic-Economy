import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendHistory, ensureEnv, homeDir, readEnv, readHistory, readJson, setEnvValue, writeJson } from "./store.js";
import type { Digest } from "./types.js";

const tmp = () => mkdtempSync(join(tmpdir(), "pd-"));

describe("store", () => {
  it("picks the data folder per platform, with an override", () => {
    assert.equal(homeDir({ PROSPERDIGEST_HOME: "/x" }, "linux"), "/x");
    assert.equal(homeDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "win32"), join("C:\\Users\\a\\AppData\\Roaming", "prosperDigest"));
    assert.equal(homeDir({ XDG_CONFIG_HOME: "/cfg" }, "linux"), join("/cfg", "prosperDigest"));
  });

  it("creates .env with placeholders once and never overwrites a filled one", () => {
    const h = tmp();
    const first = ensureEnv(h);
    assert.equal(first.created, true);
    const text = readFileSync(first.path, "utf8");
    for (const k of ["PROSPERDIGEST_TELEGRAM_BOT_TOKEN=", "PROSPERDIGEST_TELEGRAM_CHAT_ID=", "PROSPERDIGEST_DISCORD_WEBHOOK="]) assert.ok(text.includes(k), k);
    writeFileSync(first.path, text.replace("PROSPERDIGEST_DISCORD_WEBHOOK=", "PROSPERDIGEST_DISCORD_WEBHOOK=https://x"));
    assert.equal(ensureEnv(h).created, false);
    assert.equal(readEnv(h).discordWebhook, "https://x");
  });

  it("reads hand-edited values: CRLF, quotes, spaces, empty lines", () => {
    const h = tmp();
    writeFileSync(join(h, ".env"), "# c\r\nPROSPERDIGEST_TELEGRAM_BOT_TOKEN = '123:abc ' \r\nPROSPERDIGEST_TELEGRAM_CHAT_ID=\r\nPROSPERDIGEST_DISCORD_WEBHOOK=\"https://d/1/t\"\r\n");
    assert.deepEqual(readEnv(h), { telegramToken: "123:abc", telegramChatId: undefined, discordWebhook: "https://d/1/t" });
  });

  it("sets one value and keeps every other line", () => {
    const h = tmp();
    const { path } = ensureEnv(h);
    setEnvValue(h, "PROSPERDIGEST_TELEGRAM_CHAT_ID", "42");
    const after = readFileSync(path, "utf8");
    assert.ok(after.includes("PROSPERDIGEST_TELEGRAM_CHAT_ID=42"));
    assert.equal(after.split("\n").length, readFileSync(path, "utf8").split("\n").length);
    assert.ok(after.includes("# Telegram"));
    assert.equal(readEnv(h).telegramChatId, "42");
  });

  it("round-trips json and keeps history in order", () => {
    const h = tmp();
    assert.deepEqual(readJson(h, "a.json", { n: 0 }), { n: 0 });
    writeJson(h, "a.json", { n: 1 });
    assert.deepEqual(readJson(h, "a.json", { n: 0 }), { n: 1 });
    appendHistory(h, { key: "a" } as Digest);
    appendHistory(h, { key: "b" } as Digest);
    assert.deepEqual(readHistory(h).map((d) => d.key), ["a", "b"]);
  });
});
