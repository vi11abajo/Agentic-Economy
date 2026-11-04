// Reading a call trace: the part that makes bouncer different. The request only says "call this contract";
// the trace says what really happens: every contract that gets called, at any depth, every PROS and token amount
// that would leave the wallet, and every approval it would hand out. The rules then judge these facts.
//
// Two Pharos details shape this file (both seen on mainnet, 2026-11-04):
// - a DELEGATECALL frame shows the proxy itself as `to`, the proxy's caller as `from`, and repeats the parent's
//   `value`. So it adds no new address and its value must not be counted again.
// - a frame that failed carries `error`; "execute_revert" has the revert data in `output`, other errors (like
//   "insufficient_balance") are the node's own words.
import { decodeAbiParameters, decodeErrorResult, type Address, type Hex } from "viem";
import type { Frame, TraceLog } from "./chain.js";

export type Hop = { address: Address; depth: number; path: Address[]; type: string; reverted: boolean };
export type Approval = { token: Address; spender: Address; amount: bigint | "all" | "nft"; kind: "erc20" | "erc721" | "forall" };
export type Facts = {
  reverted: { reason: string } | null;
  hops: Hop[];
  prosOut: bigint;
  prosTo: Array<{ to: Address; amount: bigint; hop: Hop }>;
  tokensOut: Map<Address, bigint>;
  tokenTo: Array<{ token: Address; to: Address; amount: bigint }>;
  approvals: Approval[];
};

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const APPROVAL_FOR_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const MOVES_STATE = new Set(["CALL", "CALLCODE", "CREATE", "CREATE2"]);
// 0x01..0x11: ecrecover, sha256, ..., the BLS12-381 ones. Nothing to allowlist there.
const isPrecompile = (a: string) => BigInt(a) >= 1n && BigInt(a) <= 0x11n;

const lower = (a: string) => a.toLowerCase() as Address;
const topicAddress = (t: Hex) => lower(`0x${t.slice(26)}`);
const uint = (data: Hex) => decodeAbiParameters([{ type: "uint256" }], data)[0];

/** Revert bytes into words: Error(string), Panic, or at least the custom error's selector. */
export function explainRevert(output?: Hex): string {
  if (!output || output === "0x") return "reverted without saying why";
  try {
    const e = decodeErrorResult({ abi: [], data: output });
    if (e.errorName === "Error") return String(e.args?.[0]);
    if (e.errorName === "Panic") return `panic ${String(e.args?.[0])}`;
  } catch {
    /* not a standard error */
  }
  return `reverted with custom error ${output.slice(0, 10)}`;
}

function whyItFailed(f: Frame): string {
  if (f.error === "execute_revert") return explainRevert(f.output);
  if (f.error === "insufficient_balance") return "the wallet doesn't hold enough PROS for this (insufficient balance)";
  return f.error!.replace(/_/g, " ");
}

export function readTrace(root: Frame, wallet: Address): Facts {
  const me = lower(wallet);
  const facts: Facts = { reverted: root.error ? { reason: whyItFailed(root) } : null, hops: [], prosOut: 0n, prosTo: [], tokensOut: new Map(), tokenTo: [], approvals: [] };

  const readLogs = (logs: TraceLog[]) => {
    for (const l of logs) {
      const [topic0, owner, other, third] = l.topics.map((t) => t.toLowerCase() as Hex);
      if (!owner || topicAddress(owner) !== me) continue; // only what the wallet itself gives away
      const token = lower(l.address);
      if (topic0 === TRANSFER && l.topics.length === 3) {
        const amount = uint(l.data);
        facts.tokensOut.set(token, (facts.tokensOut.get(token) ?? 0n) + amount);
        facts.tokenTo.push({ token, to: topicAddress(other), amount });
      } else if (topic0 === APPROVAL && l.topics.length === 3) {
        facts.approvals.push({ token, spender: topicAddress(other), amount: uint(l.data), kind: "erc20" });
      } else if (topic0 === APPROVAL && l.topics.length === 4 && third) {
        facts.approvals.push({ token, spender: topicAddress(other), amount: "nft", kind: "erc721" });
      } else if (topic0 === APPROVAL_FOR_ALL && l.topics.length === 3 && uint(l.data) !== 0n) {
        facts.approvals.push({ token, spender: topicAddress(other), amount: "all", kind: "forall" });
      }
    }
  };

  // `path` is the chain of contracts above this frame (starting with the wallet); `undone` says whether this frame
  // or one above it failed, so whatever it did was rolled back.
  const walk = (f: Frame, path: Address[], undone: boolean) => {
    const failed = undone || Boolean(f.error);
    let below = path;
    if (MOVES_STATE.has(f.type) && f.to && !isPrecompile(f.to)) {
      const hop: Hop = { address: lower(f.to), depth: path.length - 1, path: [...path, lower(f.to)], type: f.type, reverted: failed };
      facts.hops.push(hop);
      below = hop.path;
      const value = BigInt(f.value ?? "0x0");
      if (!failed && value > 0n && lower(f.from) === me) {
        facts.prosOut += value;
        facts.prosTo.push({ to: hop.address, amount: value, hop });
      }
    }
    if (!failed && f.type !== "STATICCALL") readLogs(f.logs ?? []);
    for (const c of f.calls ?? []) walk(c, below, failed);
  };
  walk(root, [me], false);
  return facts;
}
