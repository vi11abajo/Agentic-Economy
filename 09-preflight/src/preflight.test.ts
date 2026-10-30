// Tests on a fake chain that simulates, traces and mines a USDC-like token, with a throwaway key.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  parseTransaction,
  toFunctionSelector,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { CallResult, Chain, Frame, Receipt, TraceLog, TxRequest } from "./chain.js";
import { main, TOKENS } from "./cli.js";
import { CUSTOM, decodeRevert, explainBalance } from "./errors.js";
import { effects } from "./sim.js";

const USDC = TOKENS.USDC;
const BOB = "0x89Ba8B984A709a1f02350dbd58b3e730119bb2Aa" as Address;
const abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);
const GWEI = 1_000_000_000n;

/** A token with balances, a chain that charges gas used x 10 gwei, and a trace like Pharos' callTracer. */
function fakeChain(me: Address, o: { usdc?: bigint; pros?: bigint; mineDifferent?: boolean } = {}) {
  const usdc = new Map<string, bigint>([[me.toLowerCase(), o.usdc ?? 5_000_000n]]);
  const pros = new Map<string, bigint>([[me.toLowerCase(), o.pros ?? parseEther("0.1")]]);
  const sent: Hex[] = [];
  const receipts = new Map<Hex, Receipt>();

  function run(tx: TxRequest): { ok: boolean; out: Hex; logs: TraceLog[] } {
    if (tx.data === "0x") return { ok: true, out: "0x", logs: [] };
    const d = decodeFunctionData({ abi, data: tx.data });
    if (d.functionName === "transfer") {
      const [to, amount] = d.args as [Address, bigint];
      const have = usdc.get(tx.from.toLowerCase()) ?? 0n;
      if (have < amount) return { ok: false, out: encodeErrorResult({ abi, errorName: "ERC20InsufficientBalance", args: [tx.from, have, amount] }), logs: [] };
      return { ok: true, out: pad("0x1"), logs: [{ address: USDC, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from: tx.from, to } }) as Hex[], data: pad(`0x${amount.toString(16)}`) }] };
    }
    if (d.functionName === "approve") {
      const [spender, amount] = d.args as [Address, bigint];
      return { ok: true, out: pad("0x1"), logs: [{ address: USDC, topics: encodeEventTopics({ abi, eventName: "Approval", args: { owner: tx.from, spender } }) as Hex[], data: pad(`0x${amount.toString(16)}`) }] };
    }
    return { ok: false, out: "0x", logs: [] };
  }

  const chain: Chain = {
    blockNumber: async () => 101n,
    call: async (tx): Promise<CallResult> => {
      const r = run(tx);
      return r.ok ? { ok: true, data: r.out } : { ok: false, data: r.out, message: "execution reverted" };
    },
    estimateGas: async (tx) => {
      const r = run(tx);
      return r.ok ? { ok: true, data: "0x", gas: tx.data === "0x" ? 21_000n : 50_000n } : { ok: false, data: r.out, message: "execution reverted" };
    },
    read: async (to, data) => {
      const d = decodeFunctionData({ abi, data });
      if (d.functionName === "decimals") return encodeFunctionResult({ abi, functionName: "decimals", result: 6 });
      if (d.functionName === "symbol") return encodeFunctionResult({ abi, functionName: "symbol", result: "USDC" });
      if (d.functionName === "balanceOf") return encodeFunctionResult({ abi, functionName: "balanceOf", result: usdc.get(String(d.args![0]).toLowerCase()) ?? 0n });
      if (d.functionName === "allowance") return encodeFunctionResult({ abi, functionName: "allowance", result: 0n });
      if (d.functionName === "latestRoundData") return encodeFunctionResult({ abi, functionName: "latestRoundData", result: [1n, 50_000_000n, 0n, 0n, 1n] });
      throw new Error(`unexpected read ${to}`);
    },
    gasPrice: async () => ({ gasPrice: 10n * GWEI, priority: 0n }),
    balance: async (a) => pros.get(a.toLowerCase()) ?? 0n,
    code: async () => "0x6080",
    trace: async (tx): Promise<Frame> => {
      const r = run(tx);
      return { type: "CALL", from: tx.from, to: tx.to, value: `0x${tx.value.toString(16)}`, output: r.out, error: r.ok ? undefined : "execute_revert", logs: r.logs };
    },
    nonce: async () => 3,
    sendRaw: async (raw) => {
      sent.push(raw);
      const t = parseTransaction(raw);
      const tx = { from: me, to: t.to!, data: (t.data ?? "0x") as Hex, value: t.value ?? 0n };
      const r = run(tx);
      const logs = o.mineDifferent ? [] : r.logs;
      const hash = keccak256(raw);
      receipts.set(hash, { hash, status: r.ok ? "success" : "reverted", block: 102n, gasUsed: 40_000n, effectiveGasPrice: 10n * GWEI, logs });
      return hash;
    },
    receipt: async (h) => receipts.get(h) ?? null,
    close: async () => {},
  };
  return { chain, sent };
}

function setup(o: Parameters<typeof fakeChain>[1] = {}) {
  const home = mkdtempSync(join(tmpdir(), "preflight-"));
  const key = generatePrivateKey();
  writeFileSync(join(home, ".env"), `PRIVATE_KEY=${key}\n`);
  const me = privateKeyToAccount(key).address;
  const fc = fakeChain(me, o);
  const lines: string[] = [];
  return { me, fc, lines, deps: { home, chain: async () => fc.chain, out: (s: string) => lines.push(s) } };
}

describe("revert reasons", () => {
  it("knows each custom error by its real selector", () => {
    for (const [sel, e] of Object.entries(CUSTOM)) assert.equal(toFunctionSelector(`${e.name}(${e.args.join(",")})`), sel, e.name);
  });

  it("decodes Error(string), Panic and custom errors", () => {
    const err = ("0x08c379a0" + encodeAbiParameters([{ type: "string" }], ["ERC20: transfer amount exceeds balance"]).slice(2)) as Hex;
    assert.equal(decodeRevert(err), 'Error("ERC20: transfer amount exceeds balance")');
    assert.equal(decodeRevert(("0x4e487b71" + encodeAbiParameters([{ type: "uint256" }], [0x11n]).slice(2)) as Hex), "Panic(0x11): arithmetic overflow or underflow");
    const bal = decodeRevert(encodeErrorResult({ abi, errorName: "ERC20InsufficientBalance", args: [BOB, 5n, 10_000_000n] }));
    assert.equal(explainBalance(bal, "USDC", 6), `ERC20InsufficientBalance(${BOB}, 5, 10000000): has 0.000005 USDC, needs 10`);
    assert.equal(decodeRevert("0x", "execution reverted"), "reverted without a reason");
  });
});

describe("what a trace says would change", () => {
  it("counts PROS sent with calls, token transfers, approvals; skips failed frames and NFTs", () => {
    const A = "0x00000000000000000000000000000000000000aa" as Address;
    const B = "0x00000000000000000000000000000000000000bb" as Address;
    const transfer = (from: Address, to: Address, v: bigint): TraceLog => ({ address: USDC, topics: encodeEventTopics({ abi, eventName: "Transfer", args: { from, to } }) as Hex[], data: pad(`0x${v.toString(16)}`) });
    const nft: TraceLog = { ...transfer(A, B, 1n), topics: [...transfer(A, B, 1n).topics, pad("0x7")] };
    const fx = effects({
      type: "CALL", from: A, to: B, value: "0x64", logs: [transfer(A, B, 7n), nft],
      calls: [{ type: "CALL", from: B, to: A, value: "0x5", error: "execute_revert", logs: [transfer(B, A, 99n)] }],
    });
    assert.equal(fx.native.get(A.toLowerCase()), -100n);
    assert.equal(fx.native.get(B.toLowerCase()), 100n);
    assert.equal(fx.tokens.get(`${USDC.toLowerCase()}|${B.toLowerCase()}`), 7n);
    assert.equal(fx.tokens.size, 2);
  });
});

describe("check and send", () => {
  it("GO: shows the gas cost and balances before -> after, and sends nothing", async () => {
    const t = setup();
    assert.equal(await main(["check", "token", "USDC", BOB, "1.5"], t.deps), 0);
    const out = t.lines.join("\n");
    assert.match(out, /SIMULATION {2}success/);
    assert.match(out, /estimate 50,000 at 10 gwei = 0\.0005 PROS/);
    assert.match(out, /USDC you\s+5 USDC -> 3\.5 USDC {2}\(-1\.5\)/);
    assert.match(out, /USDC 0x89ba…b2aa\s+0 USDC -> 1\.5 USDC {2}\(\+1\.5\)/);
    assert.match(out, /VERDICT {2}GO/);
    assert.equal(t.fc.sent.length, 0);
  });

  it("NO-GO: a revert blocks send, nothing is signed", async () => {
    const t = setup({ usdc: 1_000_000n });
    assert.equal(await main(["send", "token", "USDC", BOB, "10", "--yes"], t.deps), 3);
    const out = t.lines.join("\n");
    assert.match(out, /REVERT: ERC20InsufficientBalance\(.+\): has 1 USDC, needs 10/);
    assert.match(out, /BLOCKED/);
    assert.equal(t.fc.sent.length, 0);
  });

  it("NO-GO when the wallet can't pay value + gas", async () => {
    const t = setup({ pros: parseEther("0.0005") });
    assert.equal(await main(["check", "pros", BOB, "0.0004"], t.deps), 3);
    assert.match(t.lines.join("\n"), /not enough PROS/);
  });

  it("warns about an unlimited approval", async () => {
    const t = setup();
    assert.equal(await main(["check", "approve", "USDC", BOB, "max"], t.deps), 0);
    assert.match(t.lines.join("\n"), /allowance USDC you -> 0x89ba…b2aa\s+0 USDC -> unlimited/);
    assert.match(t.lines.join("\n"), /WARNING {5}unlimited approval/);
  });

  it("send without --yes only shows what would be sent", async () => {
    const t = setup();
    assert.equal(await main(["send", "token", "USDC", BOB, "1"], t.deps), 0);
    assert.equal(t.fc.sent.length, 0);
    assert.match(t.lines.join("\n"), /Not sent/);
  });

  it("send --yes signs with the simulated gas, sends, and compares", async () => {
    const t = setup();
    assert.equal(await main(["send", "token", "USDC", BOB, "1", "--yes"], t.deps), 0, t.lines.join("\n"));
    assert.equal(t.fc.sent.length, 1);
    const tx = parseTransaction(t.fc.sent[0]);
    assert.equal(tx.chainId, 1672);
    assert.equal(tx.gas, 60_000n);
    assert.match(t.lines.join("\n"), /RESULT {2}as simulated/);
  });

  it("says so when the mined result differs from the simulation", async () => {
    const t = setup({ mineDifferent: true });
    assert.equal(await main(["send", "token", "USDC", BOB, "1", "--yes"], t.deps), 4);
    assert.match(t.lines.join("\n"), /DIFFERENT/);
  });
});
