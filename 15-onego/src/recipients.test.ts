import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import type { Address, Hex } from "viem";
import { fromTape, type Chain } from "./chain.js";
import { recentWallets } from "./recipients.js";

const { tape, exclude } = JSON.parse(readFileSync(new URL("../test/tapes/recipients.json", import.meta.url), "utf8"));

// A tiny made-up chain: block 100 has a delegated (EIP-7702) wallet and a plain one, 99 repeats the plain one.
function littleChain(blocks: Record<number, Address[]>, code: Record<string, Hex>, top = 100n): Chain {
  return {
    blockNumber: async () => top,
    block: async (n: bigint) => ({ number: n, timestamp: 0n, senders: blocks[Number(n)] ?? [] }),
    code: async (a: Address) => code[a.toLowerCase()] ?? "0x",
  } as unknown as Chain;
}
const PLAIN = "0x1111111111111111111111111111111111111111";
const DELEGATED = "0x2222222222222222222222222222222222222222";

describe("recentWallets", () => {
  it("takes the ten latest plain wallets from mainnet, newest first", async () => {
    const got = await recentWallets(fromTape(tape), 10, { exclude });
    assert.equal(got.length, 10);
    assert.equal(new Set(got.map((g) => g.address)).size, 10);
    for (let i = 1; i < got.length; i++) assert.ok(got[i - 1].block >= got[i].block);
    assert.ok(got.every((g) => !exclude.map((e: string) => e.toLowerCase()).includes(g.address.toLowerCase())));
  });

  it("skips wallets that have code, delegated ones included", async () => {
    const chain = littleChain({ 100: [DELEGATED, PLAIN], 99: [PLAIN] }, { [DELEGATED]: "0xef0100d5b90ec82901a127496f1213a0079fc2f3d1fdc6" });
    const got = await recentWallets(chain, 5, { exclude: [], maxBlocks: 3 });
    assert.deepEqual(got.map((g) => g.address.toLowerCase()), [PLAIN]);
  });

  it("returns what it found when the blocks run out", async () => {
    const got = await recentWallets(littleChain({ 100: [PLAIN] }, {}), 10, { exclude: [], maxBlocks: 5 });
    assert.equal(got.length, 1);
  });

  it("leaves out the addresses it's told to", async () => {
    const got = await recentWallets(littleChain({ 100: [PLAIN] }, {}), 10, { exclude: [PLAIN.toUpperCase().replace("0X", "0x") as Address], maxBlocks: 2 });
    assert.equal(got.length, 0);
  });
});
