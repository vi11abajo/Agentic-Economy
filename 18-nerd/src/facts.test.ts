import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { cctpFacts, x402Facts } from "./facts.js";
import type { DocPage } from "./docs.js";

// Real page text as the Docs MCP getPage returned it on 2026-11-05.
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

test("x402 page gives the EIP-712 settings, the scale and the prices", () => {
  const f = x402Facts([x402Page]);
  assert.equal(f.token?.value, "0xc879c018db60520f4355c26ed1a6d572cdac1815");
  assert.equal(f.tokenName?.value, "USDC");
  assert.equal(f.version?.value, "2");
  assert.equal(f.chainId?.value, "1672");
  assert.equal(f.decimals?.value, "6");
  assert.equal(f.example?.value, "0.01");
  assert.equal(f.exampleUnits, "10000");
  assert.deepEqual(f.prices.map((p) => p.value), ["0.01", "0.005"]);
});

test("every x402 fact carries the exact line it came from", () => {
  const f = x402Facts([x402Page]);
  for (const fact of [f.token, f.tokenName, f.version, f.chainId, f.decimals, f.example, ...f.prices]) {
    assert.ok(fact);
    assert.ok(x402Page.text.includes(fact.quote.text), fact.quote.text);
    assert.equal(fact.quote.url, x402Page.url);
  }
});

test("CCTP page gives the mainnet transmitter, the domain, the finality line and the header table", () => {
  const f = cctpFacts([cctpPage]);
  assert.equal(f.transmitter?.value, "0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
  assert.equal(f.localDomain?.value, "31");
  assert.equal(f.messenger?.value, "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
  assert.equal(f.finalizedAt?.value, "2000");
  assert.equal(f.version?.value, "1");
  assert.ok(f.nonceNote?.text.includes("offchain"));
  assert.deepEqual(
    f.header.map((h) => [h.name, h.offset, h.length]),
    [
      ["version", 0, 4],
      ["sourceDomain", 4, 4],
      ["destinationDomain", 8, 4],
      ["nonce", 12, 32],
      ["sender", 44, 32],
      ["recipient", 76, 32],
      ["destinationCaller", 108, 32],
      ["minFinalityThreshold", 140, 4],
      ["finalityThresholdExecuted", 144, 4],
      ["messageBody", 148, undefined],
    ],
  );
});

test("a page that says nothing gives nothing, not a guess", () => {
  const empty: DocPage = { url: "https://docs.pharos.xyz/x", title: "x", text: "# x\nnothing here" };
  const x = x402Facts([empty]);
  assert.equal(x.token, undefined);
  assert.equal(x.version, undefined);
  assert.deepEqual(x.prices, []);
  const c = cctpFacts([empty]);
  assert.equal(c.transmitter, undefined);
  assert.deepEqual(c.header, []);
});
