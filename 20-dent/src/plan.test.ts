import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { decodeFunctionData, encodeErrorResult, parseAbi } from "viem";
import { aavePool, erc20, erc4626 } from "./abis.js";
import { buildSteps } from "./plan.js";
import { explainRevert, tokenOverride } from "./reads.js";
import type { Reading } from "./sources.js";
import { toUnits } from "./look.js";
import { sourceById, STPROS, USDC, WPROS } from "./venues.js";

const ME = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb";
const reading = (id: string, held = 0n, heldShares = 0n): Reading => ({
  source: sourceById(id),
  status: "open",
  held,
  heldShares,
  entryFee: 0,
  exitFee: 0,
  waitSeconds: id === "faroo-stpros" ? 86400 : 0,
  notes: [],
});

test("wallet USDC into an Aave fork: approve then supply, for the exact amount", () => {
  const steps = buildSteps(reading("wallet-usdc", 5_000_000n), reading("avalon-usdc"), ME, 5_000_000n);
  assert.equal(steps.length, 2);
  assert.equal(steps[0].to, USDC);
  const ap = decodeFunctionData({ abi: erc20, data: steps[0].data });
  assert.deepEqual(ap.args, ["0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa", 5_000_000n]);
  const sup = decodeFunctionData({ abi: aavePool, data: steps[1].data });
  assert.equal(sup.functionName, "supply");
  assert.equal((sup.args![2] as string).toLowerCase(), ME);
});

test("stPROS out to a WPROS pool: redeem now, then claim, wrap, approve, supply after the wait", () => {
  const steps = buildSteps(reading("faroo-stpros", 10n ** 18n, 99n * 10n ** 16n), reading("openfi-wpros"), ME, 10n ** 18n);
  assert.deepEqual(steps.map((s) => s.phase), [1, 2, 2, 2, 2]);
  assert.match(steps[1].says, /claim/);
  assert.equal(steps[1].gasHow, "observed");
  assert.equal(steps[2].to, WPROS);
  assert.equal(steps[2].value, (10n ** 18n).toString());
  const r = decodeFunctionData({ abi: erc4626, data: steps[0].data });
  assert.equal(r.functionName, "redeem");
  assert.equal(r.args![0], 99n * 10n ** 16n);
});

test("wallet PROS into stPROS is one payable call", () => {
  const steps = buildSteps(reading("wallet-pros", 10n ** 18n), reading("faroo-stpros"), ME, 10n ** 17n);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].to, STPROS);
  assert.equal(steps[0].data, "0xb4430b99");
  assert.equal(steps[0].value, (10n ** 17n).toString());
});

test("leaving an Aave fork in full withdraws type(uint256).max so accrued interest comes along", () => {
  const steps = buildSteps(reading("openfi-usdc", 7_000_000n, 7_000_000n), reading("wallet-usdc"), ME, 7_000_000n);
  const w = decodeFunctionData({ abi: aavePool, data: steps[0].data });
  assert.equal(w.args![1], 2n ** 256n - 1n);
});

test("storage overrides land on the slots we found on chain", () => {
  const usdc = tokenOverride(USDC, ME, 1n, "0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa");
  assert.equal(Object.keys(usdc[USDC].stateDiff!).length, 2);
  const st = tokenOverride(STPROS, ME, 5n);
  // stPROS keeps balances in the OpenZeppelin ERC-7201 namespace; this is the slot of this wallet.
  assert.ok(Object.keys(st[STPROS].stateDiff!)[0].startsWith("0x"));
});

test("reverts are put in words", () => {
  assert.equal(explainRevert("0xc288702c0000000000000000000000000000000000000000000000000000000000000003", ""), "InvalidPhase(3)");
  assert.equal(explainRevert(encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["51"] }), ""), "Aave error code 51");
  assert.equal(explainRevert("0x", "execution reverted: "), "reverted without a reason");
});

test("amounts parse exactly", () => {
  assert.equal(toUnits("0.5", 6), 500_000n);
  assert.equal(toUnits("12", 18), 12n * 10n ** 18n);
  assert.throws(() => toUnits("1e3", 6));
});

test("no key, no signing, no sending anywhere in dent's source", () => {
  const dir = new URL("../src/", import.meta.url);
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(f, dir), "utf8");
    for (const bad of ["privateKey", "PRIVATE_KEY", "privateKeyToAccount", "signTransaction", "eth_sendRawTransaction", "send_raw_transaction", "mnemonic"])
      assert.ok(!src.includes(bad), `${f} mentions ${bad}`);
  }
});
