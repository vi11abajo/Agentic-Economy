import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { parsePlan, toUnits } from "./plan.js";

const ME = "0x4da5c63c10b505e638b5bf5226df15a1c8cb804a";
const A = "0x64f26258f839af800b2ac9e3ead0ae8e7c2e0f7c";
const B = "0xc5f6fe56976e0a55aed6c0e08951a8a2f8980f45";
const problemsOf = (json: unknown) => {
  const r = parsePlan(json);
  assert.ok("problems" in r, "expected the plan to be refused");
  return r.problems.join("\n");
};

describe("parsePlan", () => {
  it("takes three buys", () => {
    const r = parsePlan({ wallet: ME, actions: [{ kind: "buy", token: "pTACO", pros: "5" }, { kind: "buy", token: "pCARR", pros: "5" }, { kind: "buy", token: "pMusk", pros: "5" }] });
    assert.ok("plan" in r);
    assert.equal(r.plan.actions.length, 3);
  });

  it("says plainly why it can't sell", () => {
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "sell", token: "pTACO", amount: "1" }] }), /sell.*approve/i);
  });

  it("won't round a too-small USDC amount down to nothing", () => {
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "send_usdc", to: A, amount: "0.0000001" }] }), /6 decimals/);
  });

  it("refuses zero and negative amounts", () => {
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "send_pros", to: A, amount: "0" }] }), /more than zero/);
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "send_pros", to: A, amount: "-1" }] }), /not an amount/);
  });

  it("refuses paying the same address twice", () => {
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "send_usdc", to: A, amount: "1" }, { kind: "send_usdc", to: getAddress(A), amount: "1" }] }), /twice/);
  });

  it("refuses sending to the wallet itself", () => {
    assert.match(problemsOf({ wallet: ME, actions: [{ kind: "send_usdc", to: ME, amount: "1" }, { kind: "send_usdc", to: B, amount: "1" }] }), /wallet itself/);
  });

  it("needs at least one action and a real wallet address", () => {
    assert.match(problemsOf({ wallet: ME, actions: [] }), /no actions/);
    assert.match(problemsOf({ wallet: "0x123", actions: [{ kind: "send_pros", to: A, amount: "1" }] }), /wallet/);
  });

  it("lists every problem at once", () => {
    const p = problemsOf({ wallet: ME, actions: [{ kind: "sell" }, { kind: "send_pros", to: "nope", amount: "1" }] });
    assert.match(p, /action 1/);
    assert.match(p, /action 2/);
  });
});

describe("toUnits", () => {
  it("counts in the token's smallest units", () => {
    assert.equal(toUnits("0.00001", 6), 10n);
    assert.equal(toUnits("5", 18), 5n * 10n ** 18n);
  });
});
