import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeFunctionData, encodeAbiParameters, encodeFunctionData, parseAbi } from "viem";
import { ScriptedLine } from "./fakes.js";
import { multicall, receiptTransfers, confirmTransfer, pinBlock, MULTICALL3 } from "./chain.js";

process.env.RECEIPTS_HOME = mkdtempSync(join(tmpdir(), "receipts-chain-"));

const fixture = (name: string) => readFileSync(new URL(`../fixtures/${name}.json`, import.meta.url), "utf8");
const WALLET = "0x9f857e7894e34d1cd09e55a8a27a8742729ea37c";
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const mc = parseAbi(["function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)"]);

test("pins two blocks behind the head so every node behind the balancer has it", async () => {
  const line = new ScriptedLine({ get_block_number: JSON.stringify({ blockNumber: "22204049" }) });
  assert.equal(await pinBlock(line), 22204047);
});

test("multicall packs the calls, keeps a failed one as a failure, and pins the block", async () => {
  const line = new ScriptedLine({
    eth_call: (args) => {
      const tx = args.transaction as { to: string; data: `0x${string}` };
      assert.equal(tx.to.toLowerCase(), MULTICALL3.toLowerCase());
      assert.equal(args.block, "22204047");
      const { args: [calls] } = decodeFunctionData({ abi: mc, data: tx.data });
      assert.equal(calls.length, 2);
      const result = encodeAbiParameters(
        [{ type: "tuple[]", components: [{ type: "bool" }, { type: "bytes" }] }],
        [[[true, encodeAbiParameters([{ type: "uint256" }], [5n])], [false, "0x"]]],
      );
      return JSON.stringify({ result });
    },
  });
  const data = encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [WALLET] });
  const out = await multicall(line, [{ to: "0x52acdeb49056518578c7af788ae2c367132e2db5", data }, { to: "0xd6d6c5b012a81d793dead821d1dd05446e1118c5", data }], 22204047);
  assert.equal(out[0].ok, true);
  assert.equal(BigInt((out[0] as { data: string }).data), 5n);
  assert.equal(out[1].ok, false);
});

test("pulls token transfers and WPROS wraps out of a real receipt, then serves it from cache", async () => {
  const { tx, receipt } = JSON.parse(fixture("swap"));
  const line = new ScriptedLine({
    get_transaction: JSON.stringify(tx),
    get_transaction_receipt: JSON.stringify(receipt),
  });
  const r = await receiptTransfers(line, tx.hash);
  assert.equal(r.status, 1);
  assert.equal(r.from, WALLET);
  assert.equal(r.block, Number(receipt.blockNumber));
  const stpros = r.transfers.find((t: { token: string }) => t.token === "0x6b0a44c64190279f7034b77c13a566e914fe5ec4");
  assert.ok(stpros, "the stPROS leg is there");
  assert.equal(stpros.from, WALLET);
  assert.ok(stpros.amount > 0n);
  assert.equal(r.unwraps.length, 1, "the router unwrapped WPROS to pay out native PROS");
  const asked = line.asked.length;
  await receiptTransfers(line, tx.hash);
  assert.equal(line.asked.length, asked, "second read comes from the cache");
});

test("an explorer amount that disagrees with the receipt loses to the receipt", async () => {
  const { tx, receipt } = JSON.parse(fixture("claim"));
  const line = new ScriptedLine({ get_transaction: JSON.stringify(tx), get_transaction_receipt: JSON.stringify(receipt) });
  const r = await receiptTransfers(line, tx.hash);
  const leg = r.transfers[0];
  const row = { transaction_hash: tx.hash, log_index: leg.logIndex, token_address: leg.token, from_address: leg.from, to_address: leg.to, value: "1", block_number: r.block, token_info: { decimals: 18 } };
  const verdict = confirmTransfer(row, r);
  assert.equal(verdict.ok, false);
  assert.equal((verdict as { chainAmount: bigint }).chainAmount, leg.amount);
  const fair = { ...row, value: String(Number(leg.amount) / 1e18) };
  assert.equal(confirmTransfer(fair, r).ok, true);
});
