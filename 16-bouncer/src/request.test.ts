import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { decodeFunctionData, maxUint256, parseAbi } from "viem";
import { parsePolicy } from "./policy.js";
import { parseRequest } from "./request.js";
import { DEAD, PMUSK_MARKET, PROSPER_ROUTER, USDC, WALLET } from "./testkit.js";

const r = parsePolicy({ wallet: WALLET, spend: { PROS: { per_tx: "1", per_day: "1" } } });
assert.ok("policy" in r);
const policy = r.policy;
const erc20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function approve(address spender, uint256 amount) returns (bool)"]);

const ok = (argv: string[]) => {
  const out = parseRequest(argv, policy);
  assert.ok("request" in out, "problem" in out ? out.problem : "");
  return out.request;
};
const problem = (argv: string[]) => {
  const out = parseRequest(argv, policy);
  assert.ok("problem" in out, "expected a problem");
  return out.problem;
};

describe("parseRequest", () => {
  it("turns a PROS send into a plain value transfer", () => {
    const req = ok(["pros", DEAD, "0.001"]);
    assert.deepEqual(req.tx, { to: DEAD, data: "0x", value: 10n ** 15n });
    assert.match(req.words, /send 0\.001 PROS to 0x0000/);
  });

  it("knows USDC's 6 decimals and encodes the transfer", () => {
    const req = ok(["token", "USDC", DEAD, "0.5"]);
    assert.equal(req.tx.to, USDC);
    assert.deepEqual(decodeFunctionData({ abi: erc20, data: req.tx.data }).args, ["0x000000000000000000000000000000000000dEaD", 500000n]);
  });

  it("refuses more decimals than the token has instead of rounding", () => {
    assert.match(problem(["token", "USDC", DEAD, "0.0000001"]), /decimals/);
  });

  it("encodes an unlimited approval as max uint256", () => {
    const req = ok(["approve", "USDC", PROSPER_ROUTER, "max"]);
    assert.equal(decodeFunctionData({ abi: erc20, data: req.tx.data }).args[1], maxUint256);
    assert.match(req.words, /unlimited/);
  });

  it("builds any contract call from a signature, with PROS attached", () => {
    const req = ok(["call", PMUSK_MARKET, "buyNative(uint256,uint256,address)", "0", "9999999999", WALLET, "--value", "0.001"]);
    assert.ok(req.tx.data.startsWith("0x383f5607"));
    assert.equal(req.tx.value, 10n ** 15n);
  });

  it("takes a transaction another tool already built", () => {
    const dir = join(process.cwd(), ".test-tmp", "request");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "tx.json");
    writeFileSync(file, JSON.stringify({ to: PMUSK_MARKET, data: "0x383f5607", value: "1000" }));
    const req = ok(["--tx", file]);
    assert.deepEqual(req.tx, { to: PMUSK_MARKET, data: "0x383f5607", value: 1000n });
  });

  it("names the address it can't read", () => {
    assert.match(problem(["pros", "0xnope", "1"]), /0xnope/);
  });

  it("refuses a zero or negative send", () => {
    assert.match(problem(["pros", DEAD, "0"]), /amount/);
    assert.match(problem(["pros", DEAD, "-1"]), /amount/);
  });

  it("asks for the token's decimals when it doesn't know them", () => {
    assert.match(problem(["token", "0x52acdeb49056518578c7af788ae2c367132e2db5", DEAD, "1"]), /decimals/);
  });
});
