import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeErrorResult, parseAbi, type Hex } from "viem";
import { accountFacts } from "./account.js";
import { fakeChain } from "./fake.js";
import { USDC, WPROS, findBySymbol } from "./registry.js";
import { outcome, publicTestKeyIndex, recipientVerdicts } from "./recipient.js";

const ME = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb" as Hex;
const PROS = findBySymbol("PROS")!;
const blacklisted = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["Blacklistable: account is blacklisted"] });

test("the zero address is a BLOCK before anything is simulated", async () => {
  const ph = fakeChain({});
  const to = "0x0000000000000000000000000000000000000000" as Hex;
  const v = recipientVerdicts(await accountFacts(ph, to), await outcome(ph, { from: ME, to, token: USDC, raw: 10_000n }), ME, USDC);
  assert.equal(v[0].level, "BLOCK");
});

test("USDC to the USDC contract: BLOCK with the contract's own reason", async () => {
  const ph = fakeChain({ [USDC.address as string]: { code: "0x6080" } }, {
    estimateGas: async () => ({ ok: false, revert: blacklisted, message: "execution reverted" }),
    call: async () => ({ ok: false, revert: blacklisted, message: "execution reverted" }),
  });
  const to = USDC.address as Hex;
  const o = await outcome(ph, { from: ME, to, token: USDC, raw: 10_000n });
  assert.equal(o.ok, false);
  const v = recipientVerdicts(await accountFacts(ph, to), o, ME, USDC);
  assert.ok(v.some((x) => x.level === "BLOCK" && /blacklisted/.test(x.says)));
});

test("PROS to WPROS: it goes through, and comes back to you as WPROS", async () => {
  const deposit = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c" as Hex;
  const ph = fakeChain({ [WPROS.address as string]: { code: "0x6080" } }, {
    trace: async () => ({
      type: "CALL", from: ME, to: WPROS.address as Hex, input: "0x", value: "0x1",
      logs: [{ address: WPROS.address as Hex, topics: [deposit, `0x${ME.slice(2).padStart(64, "0")}` as Hex], data: "0x01" }],
    }),
  });
  const to = WPROS.address as Hex;
  const o = await outcome(ph, { from: ME, to, token: PROS, raw: 1n });
  assert.equal(o.ok, true);
  const v = recipientVerdicts(await accountFacts(ph, to), o, ME, PROS);
  assert.ok(v.some((x) => x.level === "WARN" && /WPROS/.test(x.says) && /back to you/.test(x.says)));
});

test("an EIP-7702 delegated recipient is flagged with its delegate", async () => {
  const to = "0x9965507d1a55bcc2695c58ba16fb37d819b0a4dc" as Hex;
  const ph = fakeChain({ [to]: { code: "0xef0100043600008d6a1d7811a99bb1299f61825bf5f2d7", nonce: 40 } });
  const f = await accountFacts(ph, to);
  assert.equal(f.kind, "delegated");
  assert.equal(f.delegate, "0x043600008d6a1d7811a99bb1299f61825bf5f2d7");
  const v = recipientVerdicts(f, await outcome(ph, { from: ME, to, token: USDC, raw: 1n }), ME, USDC);
  assert.ok(v.some((x) => /0x0436/.test(x.says)));
});

test("Hardhat's account #5 is a key the whole internet knows", async () => {
  assert.equal(publicTestKeyIndex("0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"), 5);
  assert.equal(publicTestKeyIndex(ME), -1);
  const to = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Hex;
  const ph = fakeChain({});
  const v = recipientVerdicts(await accountFacts(ph, to), await outcome(ph, { from: ME, to, token: USDC, raw: 1n }), ME, USDC);
  assert.ok(v.some((x) => x.level === "BLOCK" && /public/.test(x.says)));
});

test("paying yourself is fine and says so", async () => {
  const ph = fakeChain({ [ME]: { nonce: 900 } });
  const v = recipientVerdicts(await accountFacts(ph, ME), await outcome(ph, { from: ME, to: ME, token: USDC, raw: 1n }), ME, USDC);
  assert.equal(v[0].level, "PASS");
  assert.match(v[0].says, /yourself/);
});

test("an address never used on Pharos is a WARN", async () => {
  const to = "0x000000000000000000000000000000000000dead" as Hex;
  const ph = fakeChain({});
  const v = recipientVerdicts(await accountFacts(ph, to), await outcome(ph, { from: ME, to, token: USDC, raw: 1n }), ME, USDC);
  assert.ok(v.some((x) => x.level === "WARN" && /never/.test(x.says)));
});

test("after a name check already said the address is unused on Pharos, it isn't said twice", async () => {
  const to = "0x000000000000000000000000000000000000dead" as Hex;
  const ph = fakeChain({});
  const v = recipientVerdicts(await accountFacts(ph, to), await outcome(ph, { from: ME, to, token: USDC, raw: 1n }), ME, USDC, { nameChecked: true });
  assert.ok(!v.some((x) => /never been used/.test(x.says)));
});
