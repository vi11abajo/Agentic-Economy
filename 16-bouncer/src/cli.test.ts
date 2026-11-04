import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { EXAMPLE_POLICY, main } from "./cli.js";
import { HIDDEN_HOP, PMUSK_MARKET, WALLET, recorded } from "./testkit.js";

const NOON = new Date("2026-11-04T12:00:00Z");
function setup(name: string, policy?: Record<string, unknown>) {
  const home = join(process.cwd(), ".test-tmp", "cli", name);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  if (policy) writeFileSync(join(home, "policy.json"), JSON.stringify(policy, null, 2));
  const out: string[] = [];
  return { home, out, run: (argv: string[], chain = recorded("pmusk-buy").chain) => main(argv, { print: (s) => void out.push(s), home, chain, now: NOON }) };
}
const buyArgs = () => {
  const r = recorded("pmusk-buy");
  return ["raw", r.tx.to, r.tx.data, "--value", "0.001"];
};

describe("bouncer CLI", () => {
  it("check prints the deny and the rule, exit 3", async () => {
    const t = setup("deny", { wallet: WALLET, contracts: [PMUSK_MARKET], spend: { PROS: { per_tx: "0.005", per_day: "0.01" } } });
    assert.equal(await t.run(["check", ...buyArgs()]), 3);
    assert.match(t.out.join("\n"), /^DENY by contracts/);
    assert.match(t.out.join("\n"), new RegExp(HIDDEN_HOP));
  });

  it("check --json gives the machine a decision it can parse", async () => {
    const t = setup("json", { wallet: WALLET, contracts: [PMUSK_MARKET], spend: { PROS: { per_tx: "0.005", per_day: "0.01" } } });
    await t.run(["check", ...buyArgs(), "--json"]);
    const v = JSON.parse(t.out.join("\n"));
    assert.equal(v.decision, "deny");
    assert.equal(v.rule, "contracts");
  });

  it("log --verify says the chain is intact, and names the line once it isn't", async () => {
    const t = setup("verify", { wallet: WALLET, contracts: [PMUSK_MARKET], spend: { PROS: { per_tx: "0.005", per_day: "0.01" } } });
    await t.run(["check", ...buyArgs()]);
    await t.run(["check", ...buyArgs()]);
    t.out.length = 0;
    assert.equal(await t.run(["log", "--verify"]), 0);
    assert.match(t.out.join("\n"), /chain intact \(2 entries\)/);
    const file = join(t.home, "audit.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").replace('"deny"', '"allow"'));
    t.out.length = 0;
    assert.equal(await t.run(["log", "--verify"]), 3);
    assert.match(t.out.join("\n"), /line 1/);
  });

  it("policy add-contract puts it on the list, and policy shows it in words", async () => {
    const t = setup("edit", { wallet: WALLET, contracts: [PMUSK_MARKET], spend: { PROS: { per_tx: "0.005", per_day: "0.01" } } });
    assert.equal(await t.run(["policy", "add-contract", HIDDEN_HOP]), 0);
    t.out.length = 0;
    await t.run(["policy"]);
    assert.match(t.out.join("\n"), new RegExp(HIDDEN_HOP));
    assert.match(t.out.join("\n"), /0\.005 PROS per transaction/);
  });

  it("policy set refuses a value that would break the file and leaves it as it was", async () => {
    const t = setup("bad-set", { wallet: WALLET, spend: { PROS: { per_tx: "0.005", per_day: "0.01" } } });
    const before = readFileSync(join(t.home, "policy.json"), "utf8");
    assert.equal(await t.run(["policy", "set", "spend.PROS.per_tx", "lots"]), 2);
    assert.equal(readFileSync(join(t.home, "policy.json"), "utf8"), before);
  });

  it("policy set window changes the hours and shows old and new", async () => {
    const t = setup("window", { wallet: WALLET, spend: {} });
    assert.equal(await t.run(["policy", "set", "window", "mon,tue", "09:00-17:00"]), 0);
    assert.match(t.out.join("\n"), /09:00/);
    const saved = JSON.parse(readFileSync(join(t.home, "policy.json"), "utf8"));
    assert.deepEqual(saved.time_window, { days: ["mon", "tue"], from: "09:00", to: "17:00", tz: "UTC" });
  });

  it("send without a key exits 2 and prints nothing that looks like one", async () => {
    const t = setup("nokey", { wallet: WALLET, spend: {} });
    assert.equal(await t.run(["send", ...buyArgs()]), 2);
    assert.doesNotMatch(t.out.join("\n"), /[0-9a-f]{64}/i);
  });

  it("policy init writes the example with the wallet filled in", async () => {
    const t = setup("init");
    assert.equal(await t.run(["policy", "init", "--wallet", WALLET]), 0);
    const saved = JSON.parse(readFileSync(join(t.home, "policy.json"), "utf8"));
    assert.equal(saved.wallet, WALLET);
    assert.equal(await t.run(["policy", "init", "--wallet", WALLET]), 2, "never overwrites an existing policy");
  });

  it("ships the same example as the repo's policy.example.json", () => {
    assert.deepEqual(JSON.parse(readFileSync(join(process.cwd(), "policy.example.json"), "utf8")), EXAMPLE_POLICY);
  });

  it("a bad request is bad input, exit 2", async () => {
    const t = setup("bad-request", { wallet: WALLET, spend: {} });
    assert.equal(await t.run(["check", "pros", "0xnope", "1"]), 2);
  });
});
