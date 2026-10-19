// Replays the real Pharos Chain MCP session recorded in sample-trace.jsonl (block 20,399,245), no network.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { McpToolError } from "@agentic-economy/pharos-mcp";
import { DEFAULT_CONTRACT, groupDigits, readContract, requireAddress, SLOTS, toSlot, ZERO, type McpCaller } from "./contract.js";
import type { Address } from "viem";

interface TraceLine {
  tool: string;
  arguments: Record<string, unknown>;
  response: unknown;
}
const TRACE: TraceLine[] = readFileSync(new URL("../sample-trace.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as TraceLine);

// The recorded run used the default (lower-case) USDC address, so the replay must too.
const USDC = DEFAULT_CONTRACT as Address;
const HOLDER = requireAddress("0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819");

/** Answers each call with the next recorded response, after checking it is exactly the recorded request. */
function replay(trace: TraceLine[], override?: (tool: string, args: Record<string, unknown>) => unknown): McpCaller {
  let i = 0;
  return {
    get calls() {
      return i;
    },
    async call<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
      const rec = trace[i++];
      assert.ok(rec, `unexpected extra call ${tool}`);
      assert.equal(tool, rec.tool, `call #${i}`);
      assert.deepEqual(JSON.parse(JSON.stringify(args)), rec.arguments, `arguments of call #${i}`);
      const custom = override?.(tool, args);
      if (custom instanceof Error) throw custom;
      return (custom ?? rec.response) as T;
    },
  };
}

describe("readContract (recorded USDC session)", () => {
  it("decodes every value the way sample-output.txt shows it", async () => {
    const r = await readContract(replay(TRACE), { contract: USDC, block: 20_399_245n, holders: [HOLDER] });
    assert.equal(r.network.chainId, 1672);
    assert.equal(r.block.number, 20_399_245n);
    assert.equal(r.block.timestampUtc, "2026-10-16T14:14:48.000Z");
    assert.deepEqual(
      { name: r.token.name, symbol: r.token.symbol, decimals: r.token.decimals, currency: r.token.currency, version: r.token.version, paused: r.token.paused },
      { name: "USDC", symbol: "USDC", decimals: 6, currency: "USD", version: "2", paused: false },
    );
    assert.equal(r.token.totalSupplyRaw, 41_609_740_342_546n);
    assert.equal(r.roles.owner, "0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92");
    assert.equal(r.roles.masterMinter, "0x908EA62d2529F31347d71992954E540A8d169603");
    assert.equal(r.roles.rescuer, ZERO, "an unassigned role reads as the zero address");
    assert.equal(r.roles.proxyAdmin, "0x46f958BdEFfD33495E058873cDd114c79Ec13F1b");
    assert.equal(r.roles.implementation, "0xC35BEcB283fEC66626220467265F6d3B3f8cEae8");
    assert.deepEqual(r.holders, [{ address: HOLDER, balance: 1_311_134_000_000n }]);
    assert.equal(r.mcpCalls, TRACE.length);
  });

  it("refuses a chain that is not Pharos Pacific Mainnet", async () => {
    const wrong = replay(TRACE, (tool) => (tool === "get_chain_info" ? { chainId: 1, latestBlock: "100" } : undefined));
    await assert.rejects(readContract(wrong, { contract: USDC, block: 20_399_245n, holders: [] }), /Unexpected chain 1/);
  });

  it("refuses an address without contract code", async () => {
    const empty = replay(TRACE, (tool) => (tool === "get_code" ? { code: "0x" } : undefined));
    await assert.rejects(readContract(empty, { contract: USDC, block: 20_399_245n, holders: [] }), /No contract code/);
  });

  it("treats a reverted call as 'function not implemented' instead of failing", async () => {
    const symbolReverts = replay(TRACE, (tool, args) =>
      tool === "eth_call" && (args.transaction as { data: string }).data === "0x95d89b41"
        ? new McpToolError("eth_call", "execution reverted")
        : undefined,
    );
    const r = await readContract(symbolReverts, { contract: USDC, block: 20_399_245n, holders: [HOLDER] });
    assert.equal(r.token.symbol, undefined);
    assert.equal(r.token.name, "USDC");
  });

  it("pins every read to one block, a few blocks behind the head when none is given", async () => {
    const latest = 20_399_245 + 3;
    const head = replay(TRACE, (tool) => (tool === "get_chain_info" ? { chainId: 1672, latestBlock: String(latest) } : undefined));
    const r = await readContract(head, { contract: USDC, holders: [HOLDER] });
    assert.equal(r.block.number, 20_399_245n);
  });
});

describe("helpers", () => {
  it("reads the proxy slots the trace used (ZeppelinOS admin/implementation)", () => {
    const slots = TRACE.filter((t) => t.tool === "get_storage_at").map((t) => t.arguments.position);
    assert.deepEqual(slots, [SLOTS.zosAdmin, SLOTS.zosImplementation]);
    assert.equal(SLOTS.eip1967Implementation, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  });

  it("groups digits only in the integer part", () => {
    assert.equal(groupDigits("41609740.342546"), "41,609,740.342546");
    assert.equal(groupDigits("1311134"), "1,311,134");
    assert.equal(groupDigits("999"), "999");
  });

  it("pads storage slots to 32 bytes and checks addresses", () => {
    assert.equal(toSlot(1n), `0x${"0".repeat(63)}1`);
    assert.throws(() => requireAddress("0x1234"), /Not an address/);
    assert.equal(requireAddress(USDC), "0xC879C018dB60520F4355C26eD1a6D572cdAC1815");
  });
});
