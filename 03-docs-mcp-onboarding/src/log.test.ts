// The onboarding log must quote the agent exactly: every query in the README table is the query saved in log/,
// and every reply quoted in README.md is in the saved reply. Also unit-tests the parsers used by verify-gaps.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { loggedQueries, rpcProviders } from "./parse.js";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const README = read("README.md");
const logOf = (n: number) => read(`log/q0${n}.txt`);

describe("onboarding log", () => {
  const rows = loggedQueries(README);

  it("lists questions 0 to 6 in order", () => {
    assert.deepEqual(rows.map((r) => r.n), [0, 1, 2, 3, 4, 5, 6]);
  });

  it("uses, for every logged answer, exactly the query sent to @Pharos Docs MCP", () => {
    for (const { n, query } of rows.filter((r) => r.n > 0)) {
      const first = logOf(n).split("\n")[0];
      assert.equal(first, `Q: @Pharos Docs MCP ${query}`, `log/q0${n}.txt`);
    }
  });

  it("quotes the agent's replies word for word", () => {
    const quotes: [number, string][] = [
      [1, "get_logs is capped at 1000 blocks per call"],
      [2, "No — get_logs does not include the block timestamp."],
      [3, "The Pharos documentation does not publish an official list of launchpad or DEX factory contracts"],
      [4, "It has to be a Skill. Anvita Flow does not provide a way to register or proxy an externally-hosted MCP server URL."],
      [5, "Contract address (Pacific Mainnet)\t0xc879c018db60520f4355c26ed1a6d572cdac1815"],
      [6, "Alchemy, QuickNode, ZAN, or your own node"],
    ];
    for (const [n, quote] of quotes) assert.ok(logOf(n).includes(quote), `log/q0${n}.txt should contain: ${quote}`);
  });
});

describe("parsers", () => {
  it("reads the provider list from the docs RPC page", () => {
    const page = "## Available RPC Providers\n\nPharos supports multiple RPC providers.\n\n* ZAN RPC\n* Nirvana RPC\n* Alchemy RPC\n\n---\n* not a provider\n";
    assert.deepEqual(rpcProviders(page), ["ZAN RPC", "Nirvana RPC", "Alchemy RPC"]);
  });
});
