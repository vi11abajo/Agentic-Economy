import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";
import { addrWord, fakeChain, word } from "./fake.js";
import { resolveName, PHAROS_COIN_TYPE } from "./names.js";

const ALICE = "0xcd2e72aebe2a203b84f46deec948e6465db51c75";
const SINGLETON = "0xd9db270c1b5e3bd161e8c8503c55ceabee709552";
const PROXY_CODE: Hex = "0x608060405273ffffffffffffffffffffffffffffffffffffffff600054163660008037600080366000845af43d6000803e6000811415603d573d6000fd5b3d6000f3fe";

const owners = encodeAbiParameters([{ type: "address[]" }], [["0x0000000000000000000000000000000000000001", "0x0000000000000000000000000000000000000002"]]);
const version = encodeAbiParameters([{ type: "string" }], ["1.3.0"]);

const ethereum = fakeChain({
  [ALICE]: {
    code: PROXY_CODE,
    nonce: 1,
    storage: { "0x0": addrWord(SINGLETON) },
    answers: { "0xe75235b8": { ok: true, data: word(1) }, "0xa0e67e2b": { ok: true, data: owners }, "0xffa1ad74": { ok: true, data: version } },
  },
  [SINGLETON]: { code: "0x6080" },
});

const only = (addr: string | null, coin?: string | null) => async (_n: string, coinType?: bigint) =>
  (coinType === undefined ? addr : coin ?? null) as Hex | null;

test("alice.eth: a Safe on Ethereum, nothing on Pharos -> BLOCK, and it says why", async () => {
  const r = await resolveName("alice.eth", ethereum, fakeChain({}), only(ALICE));
  assert.equal(r.verdict.level, "BLOCK");
  assert.equal(r.via, "eth");
  assert.equal(r.l1?.kind, "contract");
  assert.deepEqual(r.l1?.safe, { threshold: 1, owners: 2, version: "1.3.0" });
  assert.match(r.verdict.says, /Safe/);
  assert.match(r.verdict.says, /Pharos/);
});

test("an EIP-7702 delegated wallet on Ethereum is a WARN naming the delegate", async () => {
  const v = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
  const l1 = fakeChain({ [v]: { code: "0xef01005a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d", nonce: 1200 } });
  const r = await resolveName("vitalik.eth", l1, fakeChain({}), only(v));
  assert.equal(r.l1?.kind, "delegated");
  assert.equal(r.l1?.delegate, "0x5a7fc11397e9a8ad41bf10bf13f22b0a63f96f6d");
  assert.equal(r.verdict.level, "WARN");
});

test("a plain wallet on Ethereum is a WARN: same key, but confirm the person", async () => {
  const n = "0xb8c2c29ee19d8307cb7255e1cd9cbde883a267d5";
  const r = await resolveName("nick.eth", fakeChain({ [n]: { nonce: 10 } }), fakeChain({}), only(n));
  assert.equal(r.l1?.kind, "eoa");
  assert.equal(r.verdict.level, "WARN");
});

test("a record made for Pharos (ENSIP-11) that is in use there -> PASS", async () => {
  const p = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb";
  const r = await resolveName("someone.eth", fakeChain({}), fakeChain({ [p]: { nonce: 3 } }), only(ALICE, p));
  assert.equal(r.via, "ensip11");
  assert.equal(r.address?.toLowerCase(), p);
  assert.equal(r.verdict.level, "PASS");
});

test("the Pharos coin type is 0x80000000 | 1672", () => {
  assert.equal(PHAROS_COIN_TYPE, 2147485320n);
});

test("Ethereum unreachable -> BLOCK, no guessing", async () => {
  const r = await resolveName("alice.eth", ethereum, fakeChain({}), async () => {
    throw new Error("fetch failed");
  });
  assert.equal(r.verdict.level, "BLOCK");
  assert.match(r.verdict.says, /could not resolve/);
});

test("a name with no address -> BLOCK", async () => {
  const r = await resolveName("nobody-here-1234.eth", ethereum, fakeChain({}), only(null));
  assert.equal(r.verdict.level, "BLOCK");
  assert.equal(r.via, "none");
});
