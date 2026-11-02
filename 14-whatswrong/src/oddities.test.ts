// The weird transactions no tape covers: deployments, flaky nodes, swallowed inner failures, silent asserts.
// A hand-built witness plays the chain here, so each test says exactly what the chain "answered".
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeAbiParameters, encodeFunctionData, parseAbi, type Hex } from "viem";
import { performAutopsy } from "./autopsy.js";
import { whereItBroke, type CallFrame } from "./clues.js";
import { proveTheFix } from "./remedy.js";
import type { Echo, Tx, Witness } from "./witness.js";

const ME = "0x1111111111111111111111111111111111111111";
const DAPP = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x3333333333333333333333333333333333333333";
const HASH = `0x${"ab".repeat(32)}`;
const errorString = (msg: string) => `0x08c379a0${encodeAbiParameters([{ type: "string" }], [msg]).slice(2)}`;
const erc20 = parseAbi(["function transfer(address,uint256)", "function symbol() view returns (string)", "function decimals() view returns (uint8)", "function balanceOf(address) view returns (uint256)"]);
const words = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);

/** A tiny pretend chain: the tx, its trace, and how replays answer. Anything not set up blows up on purpose. */
function stage(opts: { tx?: Partial<Tx>; status?: string; gasUsed?: string; trace?: CallFrame | null | "throws"; replay?: (to: string, data: string, block: number | "latest") => Echo }): Witness {
  const tx: Tx = { hash: HASH, from: ME, to: DAPP, input: "0xdeadbeef", value: "0x0", gas: "0x186a0", blockNumber: "0x64", transactionIndex: "0x0", ...opts.tx };
  return {
    transaction: async () => tx,
    receipt: async () => ({ status: opts.status ?? "0x0", gasUsed: opts.gasUsed ?? "0x7530", blockNumber: tx.blockNumber }),
    replay: async (call, block) => (opts.replay ? opts.replay(call.to, call.data, block) : { reverted: true, revertData: "0x", message: "execution reverted" }),
    replayPatched: async () => ({ reverted: true, revertData: "0x", message: "execution reverted" }),
    estimateGas: async () => null,
    trace: async () => {
      if (opts.trace === "throws") throw new Error("fetch failed");
      return opts.trace ?? null;
    },
    block: async (n) => ({ number: n === "latest" ? 200 : n, timestamp: 1_000, transactions: [{ hash: HASH, from: ME, to: tx.to, input: tx.input, transactionIndex: "0x0" }] }),
    nameOf: async () => null,
    logs: async () => [],
  };
}

describe("odd transactions", () => {
  it("a failed contract deployment is called what it is, not a same-block race", async () => {
    const witness = stage({ tx: { to: null, input: "0x6080" }, trace: { type: "CREATE", from: ME, to: "", input: "0x6080", error: "execution reverted", output: errorString("boom") }, replay: () => ({ reverted: false, returned: "0x" }) });
    const autopsy = await performAutopsy(witness, HASH);
    assert.equal(autopsy.kind, "deployment_failed");
    assert.equal(autopsy.said.message, "boom");
    const fix = await proveTheFix(witness, autopsy);
    assert.equal(fix.check, undefined);
  });

  it("a node that can't answer is an error, not a revert and not a zero balance", async () => {
    const witness = stage({ trace: null, replay: () => { throw new Error("header not found"); } });
    await assert.rejects(performAutopsy(witness, HASH), /header not found/);
  });

  it("an unreachable trace endpoint doesn't sink the diagnosis", async () => {
    const witness = stage({ trace: "throws", replay: () => ({ reverted: true, revertData: errorString("Transaction too old"), message: "execution reverted" }) });
    const autopsy = await performAutopsy(witness, HASH);
    assert.equal(autopsy.kind, "deadline");
  });

  it("a deadline that lapsed between blocks is a deadline, even if the replay one block earlier passes", async () => {
    const trace: CallFrame = { type: "CALL", from: ME, to: DAPP, input: "0xdeadbeef", error: "execution reverted", output: errorString("Transaction too old") };
    const autopsy = await performAutopsy(stage({ trace, replay: () => ({ reverted: false, returned: "0x" }) }), HASH);
    assert.equal(autopsy.kind, "deadline");
  });

  it("a silent revert that burned all the gas is not out of gas when the trace says otherwise", async () => {
    const trace: CallFrame = { type: "CALL", from: ME, to: DAPP, input: "0xdeadbeef", error: "execution reverted", output: "0x" };
    const autopsy = await performAutopsy(stage({ gasUsed: "0x186a0", trace }), HASH);
    assert.notEqual(autopsy.kind, "out_of_gas");
  });

  it("a plain transfer of more than you have is a balance problem", async () => {
    const trace: CallFrame = { type: "CALL", from: ME, to: TOKEN, input: "0xa9059cbb", error: "execution reverted", output: errorString("ERC20: transfer amount exceeds balance") };
    const autopsy = await performAutopsy(stage({ tx: { to: TOKEN }, trace }), HASH);
    assert.equal(autopsy.kind, "balance");
  });

  it("a router paying out more than it holds isn't blamed on the user, nor called a vault", async () => {
    const payout = encodeFunctionData({ abi: erc20, functionName: "transfer", args: [ME as Hex, 500n] });
    const router = "0x4444444444444444444444444444444444444444";
    const trace: CallFrame = {
      type: "CALL", from: ME, to: DAPP, input: "0xdeadbeef", error: "execution reverted", output: "0x",
      calls: [{ type: "CALL", from: DAPP, to: router, input: "0x12345678", error: "execution reverted", output: "0x", calls: [{ type: "CALL", from: router, to: TOKEN, input: payout, error: "execution reverted", output: errorString("ERC20: transfer amount exceeds balance") }] }],
    };
    const replay = (to: string, data: string): Echo => {
      if (to === TOKEN && data.startsWith("0x70a08231")) return { reverted: false, returned: encodeAbiParameters([{ type: "uint256" }], [100n]) };
      if (to === TOKEN && data.startsWith("0x95d89b41")) return { reverted: false, returned: words("TKN") };
      if (to === TOKEN && data.startsWith("0x313ce567")) return { reverted: false, returned: encodeAbiParameters([{ type: "uint8" }], [18]) };
      if (to === router) return { reverted: true, revertData: "0x", message: "execution reverted" }; // no asset(): not a vault
      return { reverted: true, revertData: "0x", message: "execution reverted" };
    };
    const autopsy = await performAutopsy(stage({ trace, replay }), HASH);
    assert.equal(autopsy.kind, "contract_short");
  });
});

describe("following the right failure down", () => {
  it("takes the failing child whose revert the parent passed on, not a caught failure before it", () => {
    const top: CallFrame = {
      type: "CALL", from: ME, to: DAPP, input: "0x01", error: "execution reverted", output: errorString("Too little received"),
      calls: [
        { type: "CALL", from: DAPP, to: "0xaaaa000000000000000000000000000000000001", input: "0x02", error: "out of gas" },
        { type: "CALL", from: DAPP, to: "0xbbbb000000000000000000000000000000000002", input: "0x03", error: "execution reverted", output: errorString("Too little received") },
      ],
    };
    assert.equal(whereItBroke(top).to, "0xbbbb000000000000000000000000000000000002");
  });
});
