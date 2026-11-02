import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { initHome, parseArgs, parseScheduleArgs, statusText } from "./cli.js";
import { DEFAULT_CONFIG, saveConfig } from "./store.js";

describe("cli", () => {
  it("parses commands and flags", () => {
    assert.deepEqual(parseArgs(["run", "--catch-up", "--home", "/h"]), { cmd: "run", pos: [], flags: { "catch-up": true, home: "/h" } });
    assert.deepEqual(parseArgs(["schedule", "set", "fri", "18:00"]).pos, ["set", "fri", "18:00"]);
    assert.equal(parseArgs(["history", "--weeks", "4"]).flags.weeks, "4");
    assert.equal(parseArgs([]).cmd, "help");
  });

  it("parses a schedule", () => {
    assert.deepEqual(parseScheduleArgs(["mon", "09:00"], undefined), { days: 7, weekday: 1, time: "09:00" });
    assert.deepEqual(parseScheduleArgs(["daily", "7:30"], undefined), { days: 1, weekday: 1, time: "07:30" });
    assert.deepEqual(parseScheduleArgs(["daily", "18:00"], "3"), { days: 3, weekday: 1, time: "18:00" });
    assert.throws(() => parseScheduleArgs(["someday", "09:00"], undefined), /day/);
    assert.throws(() => parseScheduleArgs(["mon", "25:00"], undefined), /time/);
  });

  it("init creates .env, config and launcher, and keeps a filled .env", () => {
    const h = mkdtempSync(join(tmpdir(), "pd-"));
    const a = initHome(h, "node", "/x/prosperDigest.mjs", "linux");
    assert.equal(a.envCreated, true);
    assert.ok(existsSync(join(h, "config.json")) && existsSync(join(h, "run.sh")));
    writeFileSync(a.envPath, readFileSync(a.envPath, "utf8").replace("PROSPERDIGEST_DISCORD_WEBHOOK=", "PROSPERDIGEST_DISCORD_WEBHOOK=https://d/1/t"));
    assert.equal(initHome(h, "node", "/x/prosperDigest.mjs", "linux").envCreated, false);
    assert.ok(readFileSync(a.envPath, "utf8").includes("https://d/1/t"));
  });

  it("status says whether a line is filled, never its value", () => {
    const h = mkdtempSync(join(tmpdir(), "pd-"));
    saveConfig(h, { ...DEFAULT_CONFIG, channels: { telegram: true, discord: true } });
    writeFileSync(join(h, ".env"), "PROSPERDIGEST_TELEGRAM_BOT_TOKEN=123:secret\nPROSPERDIGEST_DISCORD_WEBHOOK=\n");
    const s = statusText(h, { head: 1000, nowSec: 1793610000 });
    assert.ok(s.includes("telegram: on, bot token filled, chat id empty"), s);
    assert.ok(s.includes("discord: on, webhook empty"), s);
    assert.ok(!s.includes("123:secret"));
  });
});
