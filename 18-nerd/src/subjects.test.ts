import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { encodeAbiParameters, encodeFunctionResult, parseAbi } from "viem";
import type { Brief, DocPage } from "./docs.js";
import { revertWith, ScriptedLine } from "./fakes.js";
import { cctpFacts } from "./facts.js";
import {
  MESSAGE_SENT_TOPIC,
  cctpSend,
  cutMessage,
  domainSeparator,
  firstCallInBlocks,
  functionsNamedIn,
  seenTx,
  x402Decimals,
  x402Domain,
  type Sheet,
} from "./subjects.js";

const x402Page: DocPage = {
  url: "https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet",
  title: "x402 Pacific Mainnet",
  text: readFileSync("fixtures/x402-pacific-mainnet.md", "utf8"),
};
const cctpPage: DocPage = {
  url: "https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp",
  title: "Circle CCTP",
  text: readFileSync("fixtures/circle-cctp.md", "utf8"),
};
const briefOf = (key: string, pages: DocPage[]): Brief => ({ key, subject: key, searched: [], pages, quotes: [], madeAt: 1 });

const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const WALLET = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const TOKEN = parseAbi(["function name() view returns (string)", "function version() view returns (string)", "function decimals() view returns (uint8)"]);

test("the separator rebuilt from the docs' four values is the one USDC returned on mainnet (2026-11-05)", () => {
  assert.equal(domainSeparator("USDC", "2", 1672n, USDC), "0x6ffe34d160f3b60b5ec680c84efc558f4ae78067d11d292a535aaf7fb0155232");
});

function tokenChain(name: string, version: string, separator: string, decimals = 6): ScriptedLine {
  return new ScriptedLine("chain", {
    eth_call: (args) => {
      const data = String((args.transaction as { data: string }).data);
      const result =
        data === "0x06fdde03" ? encodeFunctionResult({ abi: TOKEN, functionName: "name", result: name })
        : data === "0x54fd4d50" ? encodeFunctionResult({ abi: TOKEN, functionName: "version", result: version })
        : data === "0x313ce567" ? encodeFunctionResult({ abi: TOKEN, functionName: "decimals", result: decimals })
        : separator;
      return JSON.stringify({ result });
    },
  });
}

test("x402-domain: MATCH on all three when the token agrees with the docs, and it calls the docs' token address", async () => {
  const target = x402Domain();
  const brief = briefOf(target.key, [x402Page]);
  const chain = tokenChain("USDC", "2", "0x6ffe34d160f3b60b5ec680c84efc558f4ae78067d11d292a535aaf7fb0155232");
  const sheet = await target.fire(chain, brief, 100);
  assert.ok(chain.asked.every((a) => (a.args.transaction as { to: string }).to === USDC));
  const reading = target.judge(brief, sheet);
  assert.deepEqual(reading.verdicts.map((v) => v.mark), ["MATCH", "MATCH", "MATCH"]);
});

test("x402-domain: a token with another version is DIFFERENT, and the reading says signatures would fail", async () => {
  const target = x402Domain();
  const brief = briefOf(target.key, [x402Page]);
  const sheet = await target.fire(tokenChain("USDC", "1", `0x${"ab".repeat(32)}`), brief, 100);
  const reading = target.judge(brief, sheet);
  assert.deepEqual(reading.verdicts.map((v) => v.mark), ["MATCH", "DIFFERENT", "DIFFERENT"]);
  assert.match(reading.plainly.join(" "), /rejected/);
});

test("x402-domain: no token address in the docs means no chain call at all", async () => {
  const target = x402Domain();
  const chain = tokenChain("USDC", "2", "0x");
  await assert.rejects(target.fire(chain, briefOf(target.key, []), 100), /no USDC token address/);
  assert.equal(chain.asked.length, 0);
});

test("x402-decimals: prices from the docs turn into base units with the chain's decimals", async () => {
  const target = x402Decimals();
  const brief = briefOf(target.key, [x402Page]);
  const reading = target.judge(brief, await target.fire(tokenChain("USDC", "2", "0x", 6), brief, 100));
  assert.deepEqual(reading.verdicts.map((v) => v.mark), ["MATCH", "MATCH", "NOTE", "NOTE"]);
  assert.deepEqual(reading.verdicts.slice(2).map((v) => v.chainValue), ["10000 base units", "5000 base units"]);
});

test("the newest real MessageSent from mainnet cuts cleanly along the docs' offsets", () => {
  // Header of the message in tx 0x6eec53a3...14bf (block 22180628), as raw bytes.
  const header =
    "00000001" + "0000001f" + "00000000" + "00".repeat(32) +
    "000000000000000000000000" + "28b5a0e9c621a5badaa536219b3a228c8168cf5d" +
    "000000000000000000000000" + "28b5a0e9c621a5badaa536219b3a228c8168cf5d" +
    "00".repeat(32) + "000003e8" + "00000000" + "00000001";
  const pieces = cutMessage(`0x${header}`, cctpFacts([cctpPage]).header);
  const get = (n: string) => pieces.find((p) => p.field.name === n)?.hex;
  assert.equal(get("version"), "0x00000001");
  assert.equal(get("sourceDomain"), "0x0000001f");
  assert.equal(get("minFinalityThreshold"), "0x000003e8");
  assert.equal(get("messageBody"), "0x00000001");
});

function cctpChain(sendAnswer: () => string): ScriptedLine {
  const message = `0x${"00000001" + "0000001f" + "00000000" + "00".repeat(32) + "00".repeat(12) + "28b5a0e9c621a5badaa536219b3a228c8168cf5d" + "00".repeat(64) + "000007d0" + "00000000"}`;
  return new ScriptedLine("chain", {
    eth_call: (args) => {
      const data = String((args.transaction as { data: string }).data);
      if (data === "0x8d3638f4") return JSON.stringify({ result: `0x${"0".repeat(62)}1f` });
      if (data === "0x54fd4d50") return JSON.stringify({ result: `0x${"0".repeat(63)}1` });
      return sendAnswer();
    },
    estimate_gas: JSON.stringify({ gas: "47247" }),
    get_logs: (args) => {
      assert.deepEqual(args.topics, [MESSAGE_SENT_TOPIC]);
      return JSON.stringify([{ address: "x", blockNumber: "0x10", transactionHash: "0xfeed", topics: [], data: encodeAbiParameters([{ type: "bytes" }], [message as `0x${string}`]) }]);
    },
  });
}

test("cctp-send: a call that goes through is read against the docs, and the real message backs up the table", async () => {
  const target = cctpSend({ destinationDomain: 0, from: WALLET, recipient: WALLET, body: "hi" });
  const brief = briefOf(target.key, [cctpPage]);
  const sheet = await target.fire(cctpChain(() => JSON.stringify({ result: "0x" })), brief, 100);
  assert.equal(sheet.notes.minFinality, "2000", "defaults to the docs' finalized threshold");
  const reading = target.judge(brief, sheet);
  const marks = Object.fromEntries(reading.verdicts.map((v) => [v.topic.split(":")[0]!, v.mark]));
  assert.equal(marks["Pharos domain in the docs table vs localDomain()"], "MATCH");
  assert.equal(marks["destination domain 0"], "DOCS SILENT");
  assert.equal(marks["sender in a real message vs TokenMessengerV2 in the docs"], "MATCH");
  assert.match(reading.plainly.join("\n"), /Nothing was sent/);
});

test("cctp-send: the contract's own refusal is shown as CHAIN SAYS NO with its reason", async () => {
  const target = cctpSend({ destinationDomain: 31, from: WALLET, recipient: WALLET, body: "hi" });
  const brief = briefOf(target.key, [cctpPage]);
  const sheet = await target.fire(cctpChain(() => revertWith("Domain is local domain")), brief, 100);
  const reading = target.judge(brief, sheet);
  const no = reading.verdicts.find((v) => v.mark === "CHAIN SAYS NO");
  assert.equal(no?.chainValue, "Domain is local domain");
});

test("functions the docs write out get their selectors; prose in brackets does not", () => {
  const found = functionsNamedIn([{ url: "u", title: "t", text: "read it via `latestAnswer()`\ncall balanceOf(address owner)\n(see the table)" }]);
  assert.deepEqual(found.map((f) => [f.signature, f.selector]), [
    ["latestAnswer()", "0x50d25bcd"],
    ["balanceOf(address)", "0x70a08231"],
  ]);
});

test("first: empty blocks and plain transfers are walked past, the first real call is returned", async () => {
  const blocks: Record<string, unknown> = {
    "100": { number: "0x64", timestamp: "0x1", transactions: [] },
    "99": { number: "0x63", timestamp: "0x1", transactions: [{ hash: "0xa", from: "0x1", to: "0x2", input: "0x", value: "0x1", blockNumber: "0x63" }] },
    "98": { number: "0x62", timestamp: "0x1", transactions: [{ hash: "0xb", from: "0x1", to: "0x3", input: "0x095ea7b3" + "00".repeat(64), value: "0x0", blockNumber: "0x62" }] },
  };
  const chain = new ScriptedLine("chain", { get_block: (args) => JSON.stringify(blocks[String(args.block)]) });
  const seen = await firstCallInBlocks(chain, 100, 10);
  assert.equal(seen?.tx.hash, "0xb");
  assert.equal(seen?.looked, 3);
  assert.equal(seen?.empty, 1);
  assert.equal(seen?.noCalldata, 1);
});

test("a real tx the docs know nothing about reads DOCS SILENT twice and is replayed one block earlier as its sender", async () => {
  const tx = { hash: `0x${"cd".repeat(32)}`, from: "0x1f9c377fa656cb831b621a65eac0354ec2cbd107", to: "0x40858070814a57fdf33a613ae84fe0a8b4a874f7", input: "0xde5e0b9a00", value: "0x0", blockNumber: "0x100" };
  const target = seenTx(tx);
  const chain = new ScriptedLine("chain", { eth_call: JSON.stringify({ result: "0x" }) });
  const sheet: Sheet = await target.fire(chain, briefOf(target.key, []), 999);
  assert.equal(chain.asked[0]?.args.block, "255");
  assert.equal((chain.asked[0]?.args.transaction as { from: string }).from, tx.from);
  const reading = target.judge(briefOf(target.key, []), sheet);
  assert.deepEqual(reading.verdicts.map((v) => v.mark), ["DOCS SILENT", "DOCS SILENT", "NOTE"]);
});
