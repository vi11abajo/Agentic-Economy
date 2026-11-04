import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CAPS } from "./params.js";
import { appendHistory, homeDir, loadAccount, loadCaps, loadDraw, saveDraw } from "./store.js";

const scratch = () => {
  mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
  return mkdtempSync(join(process.cwd(), ".test-tmp", "home-"));
};

test("homeDir honors KICKBACK_HOME", () => {
  assert.equal(homeDir({ KICKBACK_HOME: "D:/somewhere" }, "win32"), "D:/somewhere");
  assert.match(homeDir({ APPDATA: "C:/Users/x/AppData/Roaming" }, "win32"), /kickback$/);
});

test("loadCaps writes config.json with the defaults the first time", () => {
  const home = scratch();
  assert.deepEqual(loadCaps(home), DEFAULT_CAPS);
  assert.deepEqual(JSON.parse(readFileSync(join(home, "config.json"), "utf8")), DEFAULT_CAPS);
});

test("loadCaps keeps what the user wrote", () => {
  const home = scratch();
  loadCaps(home);
  const file = join(home, "config.json");
  const edited = { ...DEFAULT_CAPS, max_total_usdc: "0.5" };
  writeFileSync(file, JSON.stringify(edited));
  assert.equal(loadCaps(home).max_total_usdc, "0.5");
});

test("loadAccount returns null without a .env", () => {
  assert.equal(loadAccount(scratch()), null);
});

test("saveDraw then loadDraw keeps bigints", () => {
  const home = scratch();
  const state = { commit: { tx: "0xabc" as const, block: 22133194n }, pool: { snapshot: 5n, people: ["0x1"] } };
  saveDraw(home, "0xabc", state);
  assert.deepEqual(loadDraw(home, "0xabc"), state);
  assert.equal(loadDraw(home, "0xdef"), null);
});

test("appendHistory adds one line per draw", () => {
  const home = scratch();
  appendHistory(home, { a: 1n });
  appendHistory(home, { a: 2n });
  const lines = readFileSync(join(home, "draws.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.ok(existsSync(join(home, "draws.jsonl")));
});
