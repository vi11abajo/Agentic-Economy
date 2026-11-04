import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxUint256, parseEther, type Address } from "viem";
import { parsePolicy, type Policy } from "./policy.js";
import { checkApprovals, checkContracts, checkRecipients, checkSimulation, checkSpendPerDay, checkSpendPerTx, checkTimeWindow, judge, type Situation } from "./rules.js";
import { DEAD, HIDDEN_HOP, PMUSK_MARKET, PROSPER_ROUTER, USDC, WALLET, recorded } from "./testkit.js";
import { readTrace, type Facts } from "./trace.js";

const BUY_HOPS = [PMUSK_MARKET, HIDDEN_HOP, "0x3c22060c99ee18097029151113478b4264041bdb", "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", "0xe318ac4113324841265d270dc2393f1bf742a7f8"];
const FRIEND = "0x1111111111111111111111111111111111111111" as Address;

function policyWith(over: Record<string, unknown> = {}): Policy {
  const r = parsePolicy({
    name: "test",
    wallet: WALLET,
    contracts: BUY_HOPS,
    recipients: [FRIEND],
    spend: { PROS: { per_tx: "0.005", per_day: "0.01" }, USDC: { token: USDC, decimals: 6, per_tx: "1", per_day: "2" } },
    ...over,
  });
  assert.ok("policy" in r, "problems" in r ? r.problems.join("; ") : "");
  return r.policy;
}

// Wednesday 2026-11-04, 12:00 UTC unless a test says otherwise.
const NOON = new Date("2026-11-04T12:00:00Z");
const situation = (facts: Facts, over: Partial<Situation> = {}): Situation => ({
  policy: policyWith(),
  now: NOON,
  facts,
  hasCode: (a) => a !== DEAD && a !== WALLET && a !== FRIEND,
  value: facts.prosOut,
  balance: parseEther("0.039"),
  worstGas: parseEther("0.0001"),
  spentToday: new Map(),
  ...over,
});
const buy = () => readTrace(recorded("pmusk-buy").frame, WALLET);
const sendTo = (to: Address, amount: bigint): Facts => ({ reverted: null, hops: [], prosOut: amount, prosTo: [{ to, amount, hop: { address: to, depth: 0, path: [WALLET, to], type: "CALL", reverted: false } }], tokensOut: new Map(), tokenTo: [], approvals: [] });

describe("time_window", () => {
  const weekdays = { days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00", to: "20:00" };
  it("lets a weekday noon through", () => assert.equal(checkTimeWindow(situation(buy(), { policy: policyWith({ time_window: weekdays }) })).ok, true));
  it("stops a request at 20:00 sharp: the end is exclusive", () => {
    const c = checkTimeWindow(situation(buy(), { policy: policyWith({ time_window: weekdays }), now: new Date("2026-11-04T20:00:00Z") }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /20:00/);
  });
  it("stops a Saturday", () => assert.equal(checkTimeWindow(situation(buy(), { policy: policyWith({ time_window: weekdays }), now: new Date("2026-11-07T12:00:00Z") })).ok, false));
  it("counts 01:00 Saturday as Friday's night window that started at 22:00", () => {
    const night = { days: ["fri"], from: "22:00", to: "02:00" };
    assert.equal(checkTimeWindow(situation(buy(), { policy: policyWith({ time_window: night }), now: new Date("2026-11-07T01:00:00Z") })).ok, true);
    assert.equal(checkTimeWindow(situation(buy(), { policy: policyWith({ time_window: night }), now: new Date("2026-11-08T01:00:00Z") })).ok, false);
  });
  it("passes when the policy sets no window", () => assert.match(checkTimeWindow(situation(buy())).reason, /no window/));
});

describe("simulation", () => {
  it("stops a tx that would fail anyway, with the chain's reason", () => {
    const c = checkSimulation(situation(readTrace(recorded("too-big-buy").frame, WALLET), { value: parseEther("1") }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /balance/);
  });
  it("stops a tx the wallet can't pay gas for", () => {
    const c = checkSimulation(situation(buy(), { balance: parseEther("0.001") }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /gas/);
  });
  it("passes a buy the wallet can afford", () => assert.equal(checkSimulation(situation(buy())).ok, true));
});

describe("contracts", () => {
  it("names the hidden contract, its depth and how the tx gets there", () => {
    const c = checkContracts(situation(buy(), { policy: policyWith({ contracts: [PMUSK_MARKET] }) }));
    assert.equal(c.ok, false);
    assert.equal(c.hop?.address, HIDDEN_HOP);
    assert.match(c.reason, new RegExp(HIDDEN_HOP));
    assert.match(c.reason, /depth 1/);
  });
  it("passes when every contract the trace touches is listed", () => assert.equal(checkContracts(situation(buy())).ok, true));
  it("ignores plain wallets: those are the recipients rule's job", () => assert.equal(checkContracts(situation(sendTo(DEAD, 1n))).ok, true));
});

describe("recipients", () => {
  it("stops PROS going to an address that isn't listed", () => {
    const c = checkRecipients(situation(sendTo(DEAD, parseEther("0.001"))));
    assert.equal(c.ok, false);
    assert.match(c.reason, new RegExp(DEAD));
  });
  it("lets PROS go to a listed friend", () => assert.equal(checkRecipients(situation(sendTo(FRIEND, 1n))).ok, true));
  it("lets tokens go to a listed contract", () => {
    const facts: Facts = { ...sendTo(FRIEND, 0n), prosTo: [], tokensOut: new Map([[USDC, 5n]]), tokenTo: [{ token: USDC, to: PMUSK_MARKET, amount: 5n }] };
    assert.equal(checkRecipients(situation(facts)).ok, true);
  });
});

describe("approvals", () => {
  const approveMax = () => readTrace(recorded("usdc-approve-max").frame, WALLET);
  it("stops an approval to a spender nobody listed", () => {
    const c = checkApprovals(situation(approveMax()));
    assert.equal(c.ok, false);
    assert.match(c.reason, new RegExp(PROSPER_ROUTER));
  });
  it("stops an unlimited approval even to a listed spender", () => {
    const c = checkApprovals(situation(approveMax(), { policy: policyWith({ approvals: { spenders: [PROSPER_ROUTER] } }) }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /unlimited/);
  });
  it("allows it when the user said unlimited is fine for that spender", () => {
    assert.equal(checkApprovals(situation(approveMax(), { policy: policyWith({ approvals: { spenders: [PROSPER_ROUTER], unlimited: true } }) })).ok, true);
  });
  it("is quiet when nothing is approved", () => assert.equal(checkApprovals(situation(buy())).ok, true));
});

describe("spend", () => {
  it("stops a single buy over the per-tx cap", () => {
    const c = checkSpendPerTx(situation(sendTo(FRIEND, parseEther("0.01"))));
    assert.equal(c.ok, false);
    assert.match(c.reason, /0\.01 PROS.*0\.005/);
  });
  it("lets a 0.001 buy through", () => assert.equal(checkSpendPerTx(situation(buy())).ok, true));
  it("stops a token that has no cap at all", () => {
    const pTaco = "0x52acdeb49056518578c7af788ae2c367132e2db5" as Address;
    const facts: Facts = { ...sendTo(FRIEND, 0n), prosTo: [], prosOut: 0n, tokensOut: new Map([[pTaco, 1n]]), tokenTo: [{ token: pTaco, to: FRIEND, amount: 1n }] };
    const c = checkSpendPerTx(situation(facts));
    assert.equal(c.ok, false);
    assert.match(c.reason, /no limit set/);
  });
  it("stops the buy that would cross the daily cap, showing both numbers", () => {
    const c = checkSpendPerDay(situation(sendTo(FRIEND, parseEther("0.003")), { spentToday: new Map([["PROS", parseEther("0.008")]]) }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /0\.008.*0\.003.*0\.01/);
  });
  it("refuses to guess today's spend from a broken log", () => {
    const c = checkSpendPerDay(situation(buy(), { spentToday: { broken: "audit log is broken at line 3" } }));
    assert.equal(c.ok, false);
    assert.match(c.reason, /line 3/);
  });
});

describe("judge", () => {
  it("lets a clean buy through and shows all seven checks", () => {
    const v = judge(situation(buy()));
    assert.equal(v.decision, "allow");
    assert.equal(v.rule, null);
    assert.equal(v.checks.length, 7);
  });
  it("stops at the first rule that says no", () => {
    const v = judge(situation({ ...buy(), prosOut: parseEther("0.02") }, { value: parseEther("0.02"), policy: policyWith({ contracts: [PMUSK_MARKET] }) }));
    assert.equal(v.decision, "deny");
    assert.equal(v.rule, "contracts");
    assert.equal(v.checks.length, 3);
  });
  it("works with an unlimited approval in the facts", () => assert.equal(judge(situation({ ...buy(), approvals: [{ token: USDC, spender: PROSPER_ROUTER, amount: maxUint256, kind: "erc20" }] })).rule, "approvals"));
});
