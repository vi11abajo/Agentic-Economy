import { test } from "node:test";
import assert from "node:assert/strict";
import { size, type Address } from "viem";
import { decodeCommit, encodeCommit, type Commit } from "./commit.js";
import { pickWinners, seedOf } from "./lottery.js";

const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const thirty = Array.from({ length: 30 }, (_, i) => who(i + 1));
const sample: Commit = {
  snapshot: 22133562n,
  delay: 5,
  winners: 3,
  token: "0xc879c018db60520f4355c26ed1a6d572cdac1815",
  amountRaw: 10n,
  pool: thirty,
};

test("encodeCommit and decodeCommit round trip with 30 addresses", () => {
  assert.deepEqual(decodeCommit(encodeCommit(sample)), sample);
});

test("the commit starts with kickback:1: so anyone can spot it", () => {
  const data = encodeCommit(sample);
  assert.equal(Buffer.from(data.slice(2, 24), "hex").toString("ascii"), "kickback:1:");
});

test("30 addresses fit in about a kilobyte (11 bytes of prefix + 37 ABI words)", () => {
  assert.equal(size(encodeCommit(sample)), 11 + 37 * 32);
});

test("decodeCommit rejects anything else", () => {
  assert.throws(() => decodeCommit("0xa9059cbb"), /not a kickback commit/);
  assert.throws(() => decodeCommit("0x"), /not a kickback commit/);
});

test("pickWinners is deterministic", () => {
  const seed = seedOf(`0x${"ab".repeat(32)}`, `0x${"cd".repeat(32)}`);
  assert.deepEqual(pickWinners(seed, thirty, 3), pickWinners(seed, thirty, 3));
});

test("pickWinners never repeats, even taking all but one", () => {
  const five = thirty.slice(0, 5);
  const got = pickWinners(`0x${"22".repeat(32)}`, five, 4);
  assert.equal(new Set(got).size, 4);
  assert.ok(got.every((w) => five.includes(w)));
});

test("pickWinners matches a vector computed by hand with viem", () => {
  // keccak256(seed, i) mod remaining: 4 of 5, then 2 of 4, then 2 of 3 (worked out separately, see the plan)
  assert.deepEqual(pickWinners(`0x${"11".repeat(32)}`, thirty.slice(0, 5), 3), [who(5), who(3), who(4)]);
});

test("seedOf mixes the block hash with the commit tx", () => {
  const h = `0x${"ab".repeat(32)}` as const;
  assert.notEqual(seedOf(h, `0x${"01".repeat(32)}`), seedOf(h, `0x${"02".repeat(32)}`));
});
