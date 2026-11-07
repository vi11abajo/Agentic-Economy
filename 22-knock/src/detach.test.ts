import { test } from "node:test";
import assert from "node:assert/strict";
import { readSignLog } from "./detach.js";

const banner = "knock signing page: http://127.0.0.1:8643/  (your payment; knock holds no key, your wallet signs)\nStops by itself once the payment is mined.\n";

test("a page nobody has used yet is still waiting", () => {
  assert.deepEqual(readSignLog(banner), { state: "waiting", ok: false, lines: [] });
});

test("a mined payment that matches the plan is done and ok", () => {
  const r = readSignLog(banner + "recheck (signature): OK - checked again at block 1: still goes through\ntx 0xab: success in block 2, gas used 75623; mined to/value/input match what knock handed to the wallet\n");
  assert.equal(r.state, "mined");
  assert.equal(r.ok, true);
  assert.equal(r.lines.length, 2);
});

test("a mined tx whose input differs is done but not ok", () => {
  const r = readSignLog(banner + "tx 0xab: success in block 2, gas used 1; mined to/value/input DO NOT match what knock handed to the wallet\n");
  assert.equal(r.state, "mined");
  assert.equal(r.ok, false);
});

test("a refused connect shows up while the page keeps waiting", () => {
  const r = readSignLog(banner + "recheck (transfer): BLOCKED - wrong account\n");
  assert.equal(r.state, "waiting");
  assert.deepEqual(r.lines, ["recheck (transfer): BLOCKED - wrong account"]);
});

test("a page that closed itself without a payment is closed, not waiting", () => {
  const r = readSignLog(banner + "closed after 30 minutes without a payment; nothing was signed here.\n");
  assert.equal(r.state, "closed");
});
