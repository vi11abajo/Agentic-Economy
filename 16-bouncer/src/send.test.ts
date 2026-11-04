import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { keccak256, type Hex, type LocalAccount } from "viem";
import { readLog, spentSince } from "./audit.js";
import type { Chain, Receipt } from "./chain.js";
import { gate } from "./gate.js";
import { loadPolicy, policyHash } from "./policy.js";
import type { Request } from "./request.js";
import { sendGated } from "./send.js";
import { HIDDEN_HOP, PMUSK_MARKET, WALLET, recorded } from "./testkit.js";

const BUY_HOPS = [PMUSK_MARKET, HIDDEN_HOP, "0x3c22060c99ee18097029151113478b4264041bdb", "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", "0xe318ac4113324841265d270dc2393f1bf742a7f8"];
const NOON = new Date("2026-11-04T12:00:00Z");
const RAW = "0x02f8aa" as Hex;

const rules = (over: Record<string, unknown> = {}) => JSON.stringify({ wallet: WALLET, contracts: BUY_HOPS, spend: { PROS: { per_tx: "0.005", per_day: "0.01" } }, ...over });
function home(name: string, policy: string) {
  const dir = join(process.cwd(), ".test-tmp", "send", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "policy.json"), policy);
  return dir;
}

// The recorded buy, plus a node that accepts the broadcast and answers with the receipt we pick.
function world(receipt: Receipt | null = { status: "success", gasUsed: 200000n, blockNumber: 1n, logs: [] }) {
  const r = recorded("pmusk-buy");
  const events: string[] = [];
  const chain: Chain = { ...r.chain, nonce: async () => 7, sendRaw: async (raw) => (events.push("sendRaw"), keccak256(raw)), receipt: async () => receipt };
  const signed: unknown[] = [];
  const account = { address: "0x46441dc99f8000959E9c48cf2a01a018d131D3bb", signTransaction: async (tx: unknown) => (signed.push(tx), events.push("sign"), RAW) } as unknown as LocalAccount;
  const request: Request = { words: "buy pMusk for 0.001 PROS", tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value } };
  return { chain, account, request, signed, events };
}
const noNap = async () => {};

describe("sendGated", () => {
  it("never reaches the signer on a deny", async () => {
    const w = world();
    const out = await sendGated(w.chain, home("deny", rules({ contracts: [PMUSK_MARKET] })), w.request, w.account, { now: NOON, sleep: noNap });
    assert.equal(out.status, "denied");
    assert.equal(out.verdict.rule, "contracts");
    assert.deepEqual(w.events, []);
  });

  it("signs exactly the tx the gate judged, and logs the hash before broadcasting", async () => {
    const w = world();
    const dir = home("allow", rules());
    let loggedBeforeSend = false;
    const chain = { ...w.chain, sendRaw: async (raw: Hex) => ((loggedBeforeSend = readLog(dir).entries.some((e) => e.kind === "sent")), w.chain.sendRaw(raw)) };
    const out = await sendGated(chain, dir, w.request, w.account, { now: NOON, sleep: noNap });
    assert.equal(out.status, "sent");
    assert.equal(out.hash, keccak256(RAW));
    assert.ok(loggedBeforeSend);
    const tx = w.signed[0] as Record<string, unknown>;
    assert.equal(tx.to, w.request.tx.to);
    assert.equal(tx.data, w.request.tx.data);
    assert.equal(tx.value, w.request.tx.value);
    assert.equal(tx.chainId, 1672);
    assert.equal(tx.nonce, 7);
    assert.equal(tx.gas, out.verdict.gasLimit);
    const kinds = readLog(dir).entries.map((e) => e.kind);
    assert.deepEqual(kinds, ["decision", "sent", "receipt"]);
  });

  it("records a reverted tx as reverted, and it costs nothing against the daily cap", async () => {
    const w = world({ status: "reverted", gasUsed: 50000n, blockNumber: 1n, logs: [] });
    const dir = home("reverted", rules());
    const out = await sendGated(w.chain, dir, w.request, w.account, { now: NOON, sleep: noNap });
    assert.equal(out.status, "reverted");
    const loaded = loadPolicy(dir);
    assert.ok("policy" in loaded);
    assert.equal(spentSince(readLog(dir).entries, new Date(0), loaded.policy).get("PROS"), undefined);
  });

  it("refuses a key that belongs to a different wallet than the policy guards", async () => {
    const w = world();
    const stranger = { ...w.account, address: "0x1111111111111111111111111111111111111111" } as LocalAccount;
    const out = await sendGated(w.chain, home("stranger", rules()), w.request, stranger, { now: NOON, sleep: noNap });
    assert.equal(out.status, "denied");
    assert.equal(out.verdict.rule, "policy");
    assert.deepEqual(w.events, []);
  });

  it("judges with the policy as it is at send time, not as it was at check time", async () => {
    const w = world();
    const dir = home("changed", rules({ contracts: [PMUSK_MARKET] }));
    assert.equal((await gate(w.chain, dir, w.request, { now: NOON })).decision, "deny");
    const newer = rules();
    writeFileSync(join(dir, "policy.json"), newer);
    const out = await sendGated(w.chain, dir, w.request, w.account, { now: NOON, sleep: noNap });
    assert.equal(out.status, "sent");
    assert.equal(out.verdict.policyHash, policyHash(newer));
  });

  it("two sends at once can't both squeeze under the daily cap", async () => {
    const w = world();
    const dir = home("race", rules({ spend: { PROS: { per_tx: "0.001", per_day: "0.001" } } }));
    const [a, b] = await Promise.all([sendGated(w.chain, dir, w.request, w.account, { now: NOON, sleep: noNap }), sendGated(w.chain, dir, w.request, w.account, { now: NOON, sleep: noNap })]);
    assert.deepEqual([a.status, b.status].sort(), ["denied", "sent"]);
    assert.equal((a.status === "denied" ? a : b).verdict.rule, "spend.per_day");
  });

  it("two sends at once never sign with the same nonce", async () => {
    const w = world();
    let broadcasts = 0;
    const chain: Chain = { ...w.chain, nonce: async () => 7 + broadcasts, sendRaw: async (raw) => (broadcasts++, keccak256(raw)) };
    const dir = home("nonce", rules());
    await Promise.all([sendGated(chain, dir, w.request, w.account, { now: NOON, sleep: noNap }), sendGated(chain, dir, w.request, w.account, { now: NOON, sleep: noNap })]);
    assert.deepEqual(w.signed.map((t) => (t as { nonce: number }).nonce).sort(), [7, 8]);
  });

  it("says 'unknown' and keeps the traced amount counted when no receipt comes", async () => {
    const w = world(null);
    const dir = home("silent", rules());
    const out = await sendGated(w.chain, dir, w.request, w.account, { now: NOON, sleep: noNap });
    assert.equal(out.status, "unknown");
    const loaded = loadPolicy(dir);
    assert.ok("policy" in loaded);
    assert.equal(spentSince(readLog(dir).entries, new Date(0), loaded.policy).get("PROS"), 1000000000000000n);
  });
});
