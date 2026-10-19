// Tests on real Docs MCP replies (test/fixtures, recorded from docs.pharos.xyz/~gitbook/mcp) and a fake chain.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { encodeAbiParameters } from "viem";
import { concise, isNoAnswer, parseAnswer, parseSearch, plain } from "./answer.js";
import { extractClaims, verifyClaims, type ChainSource } from "./verify.js";

const fixture = (name: string) => readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8");
const GETLOGS = parseAnswer(fixture("ask-getlogs-limit.txt"));
const NO_ANSWER = parseAnswer(fixture("ask-no-answer-llms.txt"));
const SKILL = parseAnswer(fixture("ask-publish-skill.txt"));
const X402 = parseAnswer(fixture("ask-x402-mainnet.txt"));

describe("reading Docs MCP replies", () => {
  it("splits the answer from its sources list, without duplicates", () => {
    assert.ok(GETLOGS.body.length > 0);
    assert.ok(!GETLOGS.body.includes("# Sources"));
    assert.equal(GETLOGS.sources[0].url, "https://docs.pharos.xyz/api-and-sdk/json-rpc-methods");
    assert.equal(new Set(GETLOGS.sources.map((s) => s.url)).size, GETLOGS.sources.length);
  });

  it("reads search results as title + link", () => {
    const pages = parseSearch(fixture("search-launchpad.txt"));
    assert.ok(pages.length > 0);
    for (const p of pages) assert.match(p.url, /^https:\/\/docs\.pharos\.xyz\//);
  });

  it("knows when the docs have no answer", () => {
    assert.equal(isNoAnswer(NO_ANSWER.body), true, "I cannot find information about the llms.txt URL");
    assert.equal(isNoAnswer("The Pharos documentation does not publish an official list of launchpad contracts."), true);
    assert.equal(isNoAnswer("`ai.pharos.xyz` is not explicitly documented as a specific site."), true);
    assert.equal(isNoAnswer("I can’t confirm EIP-7702 support on Pharos Pacific Mainnet from the available docs."), true);
    assert.equal(isNoAnswer("There’s no documented Pharos precompile for reading a previous block’s timestamp."), true);
  });

  it("doesn't mistake a real answer for a miss", () => {
    assert.equal(isNoAnswer(GETLOGS.body), false);
    assert.equal(isNoAnswer(X402.body), false);
    assert.equal(isNoAnswer(SKILL.body), false, "the 'does not describe' comes after a real answer");
    assert.equal(isNoAnswer("It has to be a Skill. Anvita Flow does not provide a way to register an MCP URL."), false);
  });

  it("prints markdown as plain text and keeps long answers short", () => {
    assert.equal(plain("**Bold** and [a link](https://x.y) and `code`"), "Bold and a link and `code`");
    assert.equal(plain("| Field | Value |\n|---|---|\n| Token | USDC |"), "Field · Value\nToken · USDC");
    const long = Array.from({ length: 10 }, (_, i) => `paragraph ${i}\nsecond line`).join("\n\n");
    const short = concise(long, 6);
    assert.equal(short.trimmed, true);
    assert.equal(short.text.split("\n\n").length, 3);
  });
});

describe("--verify claims", () => {
  it("finds the block limits the docs give for eth_getLogs", () => {
    const c = extractClaims(GETLOGS.body);
    assert.ok(c.blockLimits.includes(100), `got ${c.blockLimits}`);
    assert.ok(c.blockLimits.includes(10_000), `got ${c.blockLimits}`);
  });

  it("finds addresses and chain IDs", () => {
    const c = extractClaims(X402.body);
    assert.ok(c.addresses.includes("0xc879c018db60520f4355c26ed1a6d572cdac1815"));
    assert.ok(c.chainIds.includes(1672));
    assert.deepEqual(extractClaims(NO_ANSWER.body).addresses, []);
  });

  it("checks them on a chain with a 1000-block log limit", async () => {
    const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
    const calls: string[] = [];
    const chain: ChainSource = {
      async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
        calls.push(tool);
        if (tool === "get_chain_info") return { chainId: 1672, latestBlock: "20000000" } as T;
        if (tool === "get_code") return { code: args.address === USDC ? "0x6080" : "0x" } as T;
        if (tool === "eth_call") return { result: encodeAbiParameters([{ type: "string" }], ["USDC"]) } as T;
        if (tool === "get_logs") {
          const span = Number(BigInt(args.toBlock as string) - BigInt(args.fromBlock as string)) + 1;
          if (span > 1000) throw new Error("get_logs failed: The block range is too large. Consider narrowing it down to within 1,000 blocks.");
          return [] as T;
        }
        throw new Error(`unexpected ${tool}`);
      },
    };
    const { checks } = await verifyClaims(chain, {
      addresses: [USDC, "0x0000000000000000000000000000000000000001"],
      chainIds: [1672, 688689],
      blockLimits: [100, 1000, 10_000],
    });
    const byClaim = Object.fromEntries(checks.map((c) => [c.claim, c]));
    assert.equal(byClaim["chain ID 1672"].status, "ok");
    assert.equal(byClaim["chain ID 688689"].status, "note");
    assert.match(byClaim["0xc879…1815"].detail, /symbol\(\) = USDC/);
    assert.equal(byClaim["0x0000…0001"].status, "note");
    assert.equal(byClaim["1,000 blocks per get_logs call"].status, "ok");
    assert.match(byClaim["100 blocks per get_logs call"].detail, /real limit is 1,000 blocks/);
    assert.match(byClaim["10,000 blocks per get_logs call"].detail, /real limit is 1,000 blocks/);
    assert.ok(calls.filter((t) => t === "get_logs").length < 40, "the limit search stays cheap");
  });
});
