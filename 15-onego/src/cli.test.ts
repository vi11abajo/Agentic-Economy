import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fromTape } from "./chain.js";
import { main } from "./cli.js";
import { SIM_KEY, nonceFor, revivePlan } from "./testkit.js";

const fresh = () => mkdtempSync(join(tmpdir(), "onego-cli-"));
function run(argv: string[], extra: Partial<Parameters<typeof main>[1]> = {}) {
  const out: string[] = [];
  const deps = { home: fresh(), print: (s: string) => void out.push(s), ...extra };
  return main(argv, deps).then((code) => ({ code, text: out.join("\n") }));
}

describe("cli", () => {
  it("check prints the table for a plan, replayed from the buys tape", async () => {
    const saved = JSON.parse(readFileSync(new URL("../test/tapes/buys.json", import.meta.url), "utf8"));
    const { plan, now } = revivePlan(saved);
    const file = join(fresh(), "plan.json");
    writeFileSync(file, JSON.stringify(plan));
    const r = await run(["check", file, "--what-if-pros", "100"], { chain: fromTape(saved.tape), now, simKey: SIM_KEY, nonceFor });
    assert.equal(r.code, 0, r.text);
    assert.match(r.text, /1 transaction instead of 7/);
  });

  it("lists every problem of a bad plan and exits 2", async () => {
    const file = join(fresh(), "plan.json");
    writeFileSync(file, JSON.stringify({ wallet: "nope", actions: [{ kind: "sell" }] }));
    const r = await run(["check", file]);
    assert.equal(r.code, 2);
    assert.match(r.text, /wallet/);
    assert.match(r.text, /approve/);
  });

  it("send without a key says where to put it, and prints no key", async () => {
    const home = fresh();
    const file = join(home, "plan.json");
    writeFileSync(file, JSON.stringify({ wallet: "0x4da5c63c10b505e638b5bf5226df15a1c8cb804a", actions: [{ kind: "send_pros", to: "0x64f26258f839af800b2ac9e3ead0ae8e7c2e0f7c", amount: "1" }] }));
    const r = await run(["send", file], { home });
    assert.equal(r.code, 2);
    assert.match(r.text, /\.env/);
    assert.match(r.text, /PRIVATE_KEY=/);
    assert.doesNotMatch(r.text, /0x[0-9a-f]{64}/i);
  });

  it("refuses to take a key on the command line", async () => {
    const r = await run(["send", "plan.json", "--private-key", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.text, /59c6995e/);
  });

  it("doesn't print a key back even when it's passed where the plan file should be", async () => {
    const r = await run(["check", "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d"]);
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.text, /59c6995e/);
  });
});
