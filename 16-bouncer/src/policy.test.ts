import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadPolicy, parsePolicy, policyHash } from "./policy.js";

// The example from the design doc, as a user would write it.
const example = () => ({
  name: "demo wallet rules",
  wallet: "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb",
  time_window: { days: ["mon", "tue", "wed", "thu", "fri"], from: "08:00", to: "20:00", tz: "UTC" },
  contracts: ["0x5c3E0E4B1BE0851DCBC5F6A5CC04D799ACBE8B7F"],
  recipients: [],
  approvals: { spenders: [], unlimited: false },
  spend: {
    PROS: { per_tx: "0.005", per_day: "0.01" },
    USDC: { token: "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", decimals: 6, per_tx: "1", per_day: "2" },
  },
});

const problemsOf = (json: unknown) => {
  const r = parsePolicy(json);
  assert.ok("problems" in r, "expected the policy to be refused");
  return r.problems.join("\n");
};

describe("parsePolicy", () => {
  it("reads the design doc's example into raw units and minutes", () => {
    const r = parsePolicy(example());
    assert.ok("policy" in r);
    const p = r.policy;
    assert.equal(p.wallet, "0x46441dc99f8000959e9c48cf2a01a018d131d3bb");
    assert.equal(p.spend.PROS.perTx, 5000000000000000n);
    assert.equal(p.spend.PROS.decimals, 18);
    assert.equal(p.spend.USDC.perDay, 2000000n);
    assert.equal(p.spend.USDC.token, "0xc879c018db60520f4355c26ed1a6d572cdac1815");
    assert.deepEqual(p.timeWindow, { days: ["mon", "tue", "wed", "thu", "fri"], from: 480, to: 1200 });
  });

  it("lower-cases every address so the trace can be compared as is", () => {
    const r = parsePolicy(example());
    assert.ok("policy" in r);
    assert.deepEqual(r.policy.contracts, ["0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f"]);
  });

  it("names a key it doesn't know instead of quietly ignoring it", () => {
    assert.match(problemsOf({ ...example(), contract: [] }), /unknown key "contract"/);
  });

  it("is honest that only UTC works for now", () => {
    assert.match(problemsOf({ ...example(), time_window: { ...example().time_window, tz: "Europe/Moscow" } }), /only UTC/);
  });

  it("refuses a time that isn't one", () => {
    assert.match(problemsOf({ ...example(), time_window: { ...example().time_window, from: "25:00" } }), /from/);
  });

  it("needs the token and decimals for any asset other than PROS", () => {
    const spend = { ...example().spend, pTACO: { per_tx: "1", per_day: "2" } };
    assert.match(problemsOf({ ...example(), spend }), /pTACO/);
  });

  it("needs to know whose wallet it guards", () => {
    const { wallet: _gone, ...rest } = example();
    assert.match(problemsOf(rest), /wallet/);
  });

  it("lists every problem at once, not just the first", () => {
    const text = problemsOf({ ...example(), wallet: "0x123", contracts: ["nope"] });
    assert.match(text, /wallet/);
    assert.match(text, /nope/);
  });

  it("refuses amounts written in a way that could be misread", () => {
    assert.match(problemsOf({ ...example(), spend: { PROS: { per_tx: "1e-3", per_day: "1" } } }), /per_tx/);
    assert.match(problemsOf({ ...example(), spend: { USDC: { ...example().spend.USDC, per_tx: "0.0000001" } } }), /per_tx/);
  });

  it("allows a policy without a time window", () => {
    const { time_window: _gone, ...rest } = example();
    const r = parsePolicy(rest);
    assert.ok("policy" in r);
    assert.equal(r.policy.timeWindow, undefined);
  });
});

describe("loadPolicy", () => {
  const home = join(process.cwd(), ".test-tmp", "policy");

  it("says plainly when there is no policy yet", () => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const r = loadPolicy(home);
    assert.ok("problems" in r);
    assert.match(r.problems[0], /no policy\.json in/);
  });

  it("hashes the exact bytes of the file, so the log can say which rules decided", () => {
    const text = JSON.stringify(example());
    writeFileSync(join(home, "policy.json"), text);
    const r = loadPolicy(home);
    assert.ok("policy" in r);
    assert.equal(r.hash, policyHash(text));
    assert.match(r.hash, /^0x[0-9a-f]{64}$/);
  });
});
