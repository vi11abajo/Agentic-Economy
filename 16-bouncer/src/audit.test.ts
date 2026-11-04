import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { appendEntry, readLog, spentSince } from "./audit.js";
import { parsePolicy } from "./policy.js";
import { USDC, WALLET } from "./testkit.js";

const fresh = (name: string) => {
  const home = join(process.cwd(), ".test-tmp", "audit", name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  return home;
};
const at = (iso: string) => new Date(iso);
const lines = (home: string) => readFileSync(join(home, "audit.jsonl"), "utf8").trimEnd().split("\n");

describe("audit log", () => {
  it("chains each line to the one before it", async () => {
    const home = fresh("chain");
    const a = await appendEntry(home, { kind: "decision", decision: "deny", rule: "contracts" }, at("2026-11-04T10:00:00Z"));
    const b = await appendEntry(home, { kind: "decision", decision: "allow", rule: null }, at("2026-11-04T10:01:00Z"));
    assert.equal(a.prev, `0x${"0".repeat(64)}`);
    assert.equal(b.prev, a.hash);
    const log = readLog(home);
    assert.equal(log.brokenAt, null);
    assert.equal(log.entries.length, 2);
  });

  it("notices a line that was edited by hand", async () => {
    const home = fresh("edited");
    for (let i = 0; i < 3; i++) await appendEntry(home, { kind: "decision", decision: "deny", rule: "spend.per_tx" }, at("2026-11-04T10:00:00Z"));
    const l = lines(home);
    l[1] = l[1].replace('"deny"', '"allow"');
    writeFileSync(join(home, "audit.jsonl"), l.join("\n") + "\n");
    assert.equal(readLog(home).brokenAt, 2);
  });

  it("notices a line that went missing", async () => {
    const home = fresh("deleted");
    for (let i = 0; i < 3; i++) await appendEntry(home, { kind: "decision", decision: "deny", rule: "recipients" }, at("2026-11-04T10:00:00Z"));
    const l = lines(home);
    writeFileSync(join(home, "audit.jsonl"), [l[0], l[2]].join("\n") + "\n");
    assert.equal(readLog(home).brokenAt, 2);
  });

  it("waits for another bouncer that holds the lock, then writes", async () => {
    const home = fresh("lock");
    writeFileSync(join(home, "audit.lock"), "busy");
    setTimeout(() => rmSync(join(home, "audit.lock")), 250);
    await appendEntry(home, { kind: "decision", decision: "allow", rule: null }, at("2026-11-04T10:00:00Z"));
    assert.equal(readLog(home).entries.length, 1);
  });

  it("is an empty, unbroken log before the first decision", () => {
    assert.deepEqual(readLog(fresh("empty")), { entries: [], brokenAt: null });
  });
});

describe("spentSince", () => {
  const r = parsePolicy({ wallet: WALLET, spend: { PROS: { per_tx: "1", per_day: "1" }, USDC: { token: USDC, decimals: 6, per_tx: "1", per_day: "1" } } });
  assert.ok("policy" in r);
  const policy = r.policy;

  it("counts receipts that landed, nothing for a revert, and the traced amount while we wait", async () => {
    const home = fresh("spent");
    const now = at("2026-11-04T12:00:00Z");
    await appendEntry(home, { kind: "sent", txHash: "0xaa", amounts: { PROS: "1000" } }, at("2026-11-04T09:00:00Z"));
    await appendEntry(home, { kind: "receipt", txHash: "0xaa", status: "success", amounts: { PROS: "900" } }, at("2026-11-04T09:00:05Z"));
    await appendEntry(home, { kind: "sent", txHash: "0xbb", amounts: { PROS: "5000" } }, at("2026-11-04T10:00:00Z"));
    await appendEntry(home, { kind: "receipt", txHash: "0xbb", status: "reverted", amounts: {} }, at("2026-11-04T10:00:05Z"));
    await appendEntry(home, { kind: "sent", txHash: "0xcc", amounts: { PROS: "30", USDC: "7" } }, at("2026-11-04T11:00:00Z"));
    await appendEntry(home, { kind: "sent", txHash: "0xdd", amounts: { PROS: "77777" } }, at("2026-11-03T11:59:00Z"));
    const spent = spentSince(readLog(home).entries, new Date(now.getTime() - 24 * 3600_000), policy);
    assert.equal(spent.get("PROS"), 930n);
    assert.equal(spent.get("USDC"), 7n);
  });
});
