import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, encodeFunctionData, parseAbi, parseSignature, type Hex } from "viem";
import { fakeChain, word } from "./fake.js";
import { buildPlan, receiveCalldata, RECEIVE_ABI } from "./plan.js";
import { renderSummary } from "./render.js";
import { USDC } from "./registry.js";
import type { Intent } from "./parse.js";

const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb" as Hex;
const DEAD = "0x000000000000000000000000000000000000dEaD" as Hex;
const usdc = USDC.address as string;
const symbolUSDC = encodeAbiParameters([{ type: "string" }], ["USDC"]);

function world(usdcBalance: bigint, pros: bigint) {
  return fakeChain({
    [usdc]: {
      code: "0x6080",
      answers: { "0x70a08231": { ok: true, data: word(usdcBalance) }, "0x313ce567": { ok: true, data: word(6) }, "0x95d89b41": { ok: true, data: symbolUSDC } },
    },
    [ME.toLowerCase()]: { nonce: 900, balance: pros },
  });
}
const pay = (amount: string, token: string, recipient: string, kind: Intent["recipientKind"] = "address"): Intent => ({ amount, token, recipient, recipientKind: kind });
const noL1 = fakeChain({});

test("0.01 USDC to 0xdEaD: the calldata is exactly transfer(dead, 10000)", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.01", "USDC", DEAD), ME);
  assert.ok(r.plan, JSON.stringify(r.verdicts));
  assert.equal(r.plan.tx.data, `0xa9059cbb${"0".repeat(24)}000000000000000000000000000000000000dead${(10000).toString(16).padStart(64, "0")}`);
  assert.equal(r.plan.tx.to.toLowerCase(), usdc);
  assert.equal(r.plan.tx.value, "0x0");
  assert.equal(r.plan.tx.chainId, 1672);
  assert.equal(r.plan.sendRequest.method, "eth_sendTransaction");
});

test("the signature request is a USDC ReceiveWithAuthorization on chain 1672", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.01", "USDC", "self", "self"), ME, { now: 1_800_000_000 });
  const auth = r.plan!.byAuthorization!;
  const td = auth.typedData as { primaryType: string; domain: Record<string, unknown>; message: Record<string, unknown> };
  assert.equal(td.primaryType, "ReceiveWithAuthorization");
  assert.deepEqual(td.domain, { name: "USDC", version: "2", chainId: 1672, verifyingContract: usdc });
  assert.equal(td.message.value, "10000");
  assert.equal(td.message.validAfter, "0");
  assert.equal(td.message.validBefore, String(1_800_000_000 + 3600));
  assert.match(String(td.message.nonce), /^0x[0-9a-f]{64}$/);
  assert.equal(auth.payee.toLowerCase(), ME.toLowerCase());
});

test("a signature turns into the receiveWithAuthorization call the payee sends", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.01", "USDC", "self", "self"), ME, { now: 1_800_000_000 });
  const auth = r.plan!.byAuthorization!;
  const sig = `0x${"11".repeat(32)}${"22".repeat(32)}1b` as Hex;
  const { r: rr, s, v } = parseSignature(sig);
  const m = (auth.typedData as { message: Record<string, string> }).message;
  const expected = encodeFunctionData({
    abi: RECEIVE_ABI,
    functionName: "receiveWithAuthorization",
    args: [m.from as Hex, m.to as Hex, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce as Hex, Number(v), rr, s],
  });
  assert.equal(receiveCalldata(auth, sig), expected);
});

test("PROS that covers the amount but not the fee: BLOCK with both numbers", async () => {
  // 0.01 PROS + 50000*1.2 gas * 20 gwei max fee = 0.0112 PROS needed, wallet holds 0.0105
  const r = await buildPlan(world(0n, 10_500_000_000_000_000n), noL1, pay("0.01", "PROS", DEAD), ME);
  assert.equal(r.plan, undefined);
  const b = r.verdicts.find((v) => v.level === "BLOCK");
  assert.ok(b);
  assert.match(b.says, /0\.0105/);
  assert.match(b.says, /0\.0112/);
});

test("more decimals than the token has: BLOCK, never rounded", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.0000001", "USDC", DEAD), ME);
  assert.equal(r.plan, undefined);
  assert.ok(r.verdicts.some((v) => v.level === "BLOCK" && /decimals/.test(v.says)));
});

test("not enough USDC: BLOCK saying what you hold", async () => {
  const r = await buildPlan(world(5_000n, 10n ** 16n), noL1, pay("0.01", "USDC", DEAD), ME);
  assert.equal(r.plan, undefined);
  assert.ok(r.verdicts.some((v) => v.level === "BLOCK" && /0\.005/.test(v.says)));
});

test("a mixed-case address with a broken checksum is refused", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.01", "USDC", "0x000000000000000000000000000000000000DEaD"), ME);
  assert.equal(r.plan, undefined);
  assert.ok(r.verdicts.some((v) => v.level === "BLOCK" && /checksum/.test(v.says)));
});

test("USDT is not on Pharos mainnet's list: BLOCK asking for a contract", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("1", "USDT", DEAD), ME);
  assert.equal(r.plan, undefined);
  assert.ok(r.verdicts.some((v) => v.level === "BLOCK" && /contract address/.test(v.says)));
});

test("the summary is plain words: no JSON in it, and it says UNSIGNED", async () => {
  const r = await buildPlan(world(500_000n, 10n ** 16n), noL1, pay("0.01", "USDC", DEAD), ME);
  const text = renderSummary(r);
  assert.ok(!text.includes("{"));
  assert.match(text, /Send 0\.01 USDC/);
  assert.match(text, /UNSIGNED/);
});
