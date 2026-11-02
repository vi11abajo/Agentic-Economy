import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { readTheRevert, whereItBroke, type CallFrame } from "./clues.js";

const scene = (name: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}.json`, import.meta.url), "utf8"));

describe("reading revert data", () => {
  it("unpacks a plain Error(string)", () => {
    const tooLittle = "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000135472616e73616374696f6e20746f6f206f6c6400000000000000000000000000";
    assert.deepEqual(readTheRevert(tooLittle), { name: "Error", message: "Transaction too old", selector: "0x08c379a0", args: [] });
  });

  it("names a custom error it already knows", () => {
    assert.equal(readTheRevert("0x7dd37f70").name, "Slippage");
  });

  it("decodes the arguments of OpenZeppelin's allowance error", () => {
    const said = readTheRevert(scene("prosper-no-allowance").replayBefore.body.error.data);
    assert.equal(said.name, "ERC20InsufficientAllowance");
    assert.equal(said.args.length, 3);
  });

  it("is honest about silence and about strangers", () => {
    assert.equal(readTheRevert("0x").name, "silence");
    assert.equal(readTheRevert("0xdeadbeef").name, "unknown");
  });
});

describe("finding where it broke", () => {
  it("walks down to the frame that actually ran out of gas", () => {
    const spot = whereItBroke(scene("prosper-out-of-gas").trace as CallFrame);
    assert.equal(spot.error, "out_of_gas");
    assert.ok(spot.depth >= 1);
  });

  it("finds the USDC transfer inside the vault that bounced", () => {
    const spot = whereItBroke(scene("harbor-vault-dry").trace as CallFrame);
    assert.equal(spot.to, "0xc879c018db60520f4355c26ed1a6d572cdac1815");
    assert.equal(spot.from, "0x047cd0a91e9b92ed979189a6c8a120bf280f02e5");
    assert.equal(spot.input.slice(0, 10), "0xa9059cbb");
    assert.equal(readTheRevert(spot.output).message, "ERC20: transfer amount exceeds balance");
  });
});
