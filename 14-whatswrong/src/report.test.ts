import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { performAutopsy } from "./autopsy.js";
import { proveTheFix } from "./remedy.js";
import { asJson, factSheet } from "./report.js";
import { fromTape } from "./witness.js";

const replayed = async (name: string) => {
  const { hash, tape } = JSON.parse(readFileSync(new URL(`../test/tapes/${name}.json`, import.meta.url), "utf8"));
  const witness = fromTape(tape);
  const autopsy = await performAutopsy(witness, hash);
  return { autopsy, fix: await proveTheFix(witness, autopsy) };
};

describe("the fact sheet", () => {
  it("lays out the double sale: the earlier tx, the next problem, and no repeated hops", async () => {
    const { autopsy, fix } = await replayed("prosper-no-allowance");
    const sheet = factSheet(autopsy, fix);
    assert.match(sheet, /kind {15}allowance/);
    assert.match(sheet, /owner {14}0xAa5B49C7/);
    assert.match(sheet, /13 blocks earlier, https:\/\/www\.pharosscan\.xyz\/tx\/0x1b84dc15/);
    assert.match(sheet, /  then {13}ERC20InsufficientBalance/);
    assert.match(sheet, /\(0x63ff…22f5 -> 0x0220…74b8\)/);
  });

  it("says plainly when the fix goes through", async () => {
    const { autopsy, fix } = await replayed("faroswap-too-old");
    assert.match(factSheet(autopsy, fix), /fix works {10}the same swap with only the deadline moved/);
  });

  it("gives JSON with no bigint surprises", async () => {
    const { autopsy, fix } = await replayed("prosper-out-of-gas");
    const parsed = JSON.parse(asJson(autopsy, fix));
    assert.equal(parsed.gasLimit, "55622");
    assert.equal(parsed.fix.check.passes, true);
  });
});
