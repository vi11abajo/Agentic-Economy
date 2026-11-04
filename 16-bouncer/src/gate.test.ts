import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { readLog } from "./audit.js";
import type { Chain } from "./chain.js";
import { gate } from "./gate.js";
import { renderVerdict, verdictJson } from "./report.js";
import type { Request } from "./request.js";
import { HIDDEN_HOP, PMUSK_MARKET, WALLET, recorded } from "./testkit.js";

const BUY_HOPS = [PMUSK_MARKET, HIDDEN_HOP, "0x3c22060c99ee18097029151113478b4264041bdb", "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", "0xe318ac4113324841265d270dc2393f1bf742a7f8"];
const NOON = new Date("2026-11-04T12:00:00Z");

function homeWith(name: string, policy: Record<string, unknown> | string): string {
  const home = join(process.cwd(), ".test-tmp", "gate", name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "policy.json"), typeof policy === "string" ? policy : JSON.stringify(policy));
  return home;
}
const rules = (over: Record<string, unknown> = {}) => ({ wallet: WALLET, contracts: BUY_HOPS, spend: { PROS: { per_tx: "0.005", per_day: "0.01" } }, ...over });
const asRequest = (r: ReturnType<typeof recorded>): Request => ({ words: "buy pMusk for 0.001 PROS", tx: { to: r.tx.to, data: r.tx.data, value: r.tx.value } });

// A chain that remembers whether anyone asked it anything.
function counting(inner: Chain): { chain: Chain; asked: () => number } {
  let n = 0;
  const chain = new Proxy(inner, { get: (t, k) => (...a: unknown[]) => (n++, (t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string](...a)) });
  return { chain, asked: () => n };
}

describe("gate", () => {
  it("stops a pMusk buy when only the market is listed, and names the contract behind it", async () => {
    const r = recorded("pmusk-buy");
    const home = homeWith("hidden", rules({ contracts: [PMUSK_MARKET] }));
    const v = await gate(r.chain, home, asRequest(r), { now: NOON });
    assert.equal(v.decision, "deny");
    assert.equal(v.rule, "contracts");
    assert.match(v.reason, new RegExp(HIDDEN_HOP));
    assert.match(renderVerdict(v), /^DENY by contracts/);
    const log = readLog(home);
    assert.equal(log.entries.length, 1);
    assert.equal(log.entries[0].decision, "deny");
  });

  it("lets the same buy through once every contract it touches is listed", async () => {
    const r = recorded("pmusk-buy");
    const v = await gate(r.chain, homeWith("allow", rules()), asRequest(r), { now: NOON });
    assert.equal(v.decision, "allow", v.reason);
    assert.equal(v.block, r.block);
    assert.ok(v.gasLimit && v.maxFee);
    assert.match(renderVerdict(v), /^ALLOW/);
    assert.equal(JSON.parse(verdictJson(v)).tx.value, "1000000000000000");
  });

  it("refuses outside the time window without touching the network", async () => {
    const r = recorded("pmusk-buy");
    const spy = counting(r.chain);
    const home = homeWith("night", rules({ time_window: { days: ["mon"], from: "08:00", to: "09:00" } }));
    const v = await gate(spy.chain, home, asRequest(r), { now: NOON });
    assert.equal(v.rule, "time_window");
    assert.equal(spy.asked(), 0);
  });

  it("calls a dead node an error, never an allow, and logs it", async () => {
    const r = recorded("pmusk-buy");
    const broken = { ...r.chain, trace: async () => { throw new Error("socket hang up"); } } as Chain;
    const home = homeWith("dead-node", rules());
    const v = await gate(broken, home, asRequest(r), { now: NOON });
    assert.equal(v.decision, "error");
    assert.match(v.reason, /socket hang up/);
    assert.equal(readLog(home).entries[0].kind, "error");
  });

  it("denies everything while the policy file is broken", async () => {
    const r = recorded("pmusk-buy");
    const v = await gate(r.chain, homeWith("bad-policy", "{ not json"), asRequest(r), { now: NOON });
    assert.equal(v.rule, "policy");
  });

  it("explains a buy the wallet can't afford through the simulation rule", async () => {
    const r = recorded("too-big-buy");
    const v = await gate(r.chain, homeWith("poor", rules({ spend: { PROS: { per_tx: "5", per_day: "5" } } })), asRequest(r), { now: NOON });
    assert.equal(v.rule, "simulation");
  });
});
