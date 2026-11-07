// The knock itself. Before you pay an address on Pharos we want to know two things: who lives there, and what the
// money does after it lands. The second one we don't guess: we simulate the exact transfer from your address at
// the latest block, and for a contract we trace it and read what the contract did with it.
import { decodeErrorResult, encodeFunctionData, getAddress, parseAbi, zeroAddress, type Hex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { describe, short, type AccountFacts } from "./account.js";
import type { CallFrame, Chain } from "./chain.js";
import type { Verdict } from "./names.js";
import type { Token } from "./registry.js";

export interface Outcome {
  ok: boolean;
  says: string;
  gas?: bigint;
  block: number;
  /** For contract recipients: what the trace saw. */
  inner?: { calls: number; events: { address: Hex; topic0: Hex }[] };
  /** A PROS send that the recipient contract credited back to the sender (WPROS style). */
  creditedBack?: Hex;
}

const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);
const ERRORS = parseAbi(["error Error(string)", "error Panic(uint256)"]);
// WETH-style Deposit(address indexed dst, uint256 wad). WPROS emits it when PROS is sent to it.
const DEPOSIT_TOPIC = "0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c";

export function transferTx(p: { from: Hex; to: Hex; token: Token; raw: bigint }) {
  if (p.token.address === "native") return { from: p.from, to: p.to, value: p.raw, data: "0x" as Hex };
  return { from: p.from, to: p.token.address, value: 0n, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [p.to, p.raw] }) };
}

export function explainRevert(revert: Hex, message: string): string {
  if (revert && revert !== "0x") {
    try {
      const e = decodeErrorResult({ abi: ERRORS, data: revert });
      return e.errorName === "Error" ? String(e.args[0]) : `panic ${String(e.args[0])}`;
    } catch {
      return `custom error ${revert.slice(0, 10)}`;
    }
  }
  return message.replace(/^execution reverted:?\s*/, "") || "reverted without a reason";
}

function walk(f: CallFrame, seen: { calls: number; events: { address: Hex; topic0: Hex }[]; logs: NonNullable<CallFrame["logs"]> }) {
  for (const l of f.logs ?? []) {
    seen.events.push({ address: l.address, topic0: l.topics[0] });
    seen.logs.push(l);
  }
  for (const c of f.calls ?? []) {
    seen.calls++;
    walk(c, seen);
  }
}

export async function outcome(ph: Chain, p: { from: Hex; to: Hex; token: Token; raw: bigint }): Promise<Outcome> {
  const tx = transferTx(p);
  const block = await ph.head();
  const est = await ph.estimateGas(tx);
  if (!est.ok) {
    const sim = await ph.call(tx, "latest");
    const why = sim.ok ? explainRevert(est.revert, est.message) : explainRevert(sim.revert, sim.message);
    return { ok: false, says: `the transfer would fail on Pharos right now: ${why}`, block };
  }
  const out: Outcome = { ok: true, says: `simulated from your address at block ${block}: goes through`, gas: est.gas, block };

  // Only money that reaches a contract can do something unexpected; an ERC-20 transfer never calls the
  // recipient, so for tokens the trace is only worth it to confirm that.
  const code = await ph.code(p.to);
  if (code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) {
    const t = await ph.trace(tx);
    if (t) {
      const seen = { calls: 0, events: [] as { address: Hex; topic0: Hex }[], logs: [] as NonNullable<CallFrame["logs"]> };
      walk(t, seen);
      out.inner = { calls: seen.calls, events: seen.events };
      const back = seen.logs.find((l) => l.topics[0]?.toLowerCase() === DEPOSIT_TOPIC && l.topics[1] && BigInt(l.topics[1]) === BigInt(p.from));
      if (p.token.address === "native" && back) out.creditedBack = back.address;
    }
  }
  return out;
}

// The default Hardhat / Anvil accounts come from one published mnemonic, so their keys are public. Bots watch
// them on every chain (on Pharos #0 and #5 are already EIP-7702 delegated to someone's contract).
let testAccounts: string[] | undefined;
export function publicTestKeyIndex(a: string): number {
  testAccounts ??= Array.from({ length: 20 }, (_, i) =>
    mnemonicToAccount("test test test test test test test test test test test junk", { addressIndex: i }).address.toLowerCase(),
  );
  return testAccounts.indexOf(a.toLowerCase());
}

export function recipientVerdicts(f: AccountFacts, o: Outcome, sender: Hex, token: Token): Verdict[] {
  const to = f.address.toLowerCase();
  const out: Verdict[] = [];
  if (to === zeroAddress) return [{ level: "BLOCK", says: "that's the zero address: whatever goes there is gone for good." }];
  if (to === sender.toLowerCase()) {
    out.push({ level: "PASS", says: `paying yourself: the ${token.symbol} stays in your wallet, only the gas is spent.` });
    if (!o.ok) out.unshift({ level: "BLOCK", says: o.says });
    return out;
  }
  if (token.address !== "native" && to === token.address.toLowerCase()) {
    out.push({ level: "BLOCK", says: `that's the ${token.symbol} contract itself. Tokens sent to their own contract are usually stuck there${o.ok ? "" : `, and this one refuses anyway: ${o.says.replace(/^.*?: /, "")}`}.` });
    return out;
  }
  if (!o.ok) out.push({ level: "BLOCK", says: o.says });

  const testKey = publicTestKeyIndex(to);
  if (testKey >= 0) out.push({ level: "BLOCK", says: `${short(to)} is Hardhat/Anvil test account #${testKey}. Its private key is public, so anyone can take what you send.` });

  if (f.kind === "delegated") {
    out.push({ level: "WARN", says: `${short(to)} is a wallet delegated by EIP-7702 to ${f.delegate}. That contract's code runs for this wallet, so whoever wrote it decides what can happen to the money. Make sure the person knows their wallet is set up this way.` });
  } else if (f.kind === "contract" && o.ok) {
    if (o.creditedBack) {
      out.push({ level: "WARN", says: `${short(to)} is a token contract: PROS sent to it is wrapped and comes back to you as ${o.creditedBack.toLowerCase() === to ? "its token" : short(o.creditedBack)} (WPROS). Nobody else receives anything.` });
    } else if (o.inner && token.address === "native") {
      const emitters = [...new Set(o.inner.events.map((e) => short(e.address)))];
      out.push({ level: "WARN", says: `${short(to)} is ${describe(f)}. The simulation ran its code: ${o.inner.calls} inner call${o.inner.calls === 1 ? "" : "s"}, ${o.inner.events.length} event${o.inner.events.length === 1 ? "" : "s"}${emitters.length ? ` (from ${emitters.join(", ")})` : ""}. Only send if you know what this contract does with PROS.` });
    } else {
      out.push({ level: "WARN", says: `${short(to)} is ${describe(f)} on Pharos, not a person's wallet. ${token.symbol} sent there can only move again if that contract's code allows it.` });
    }
  } else if (f.kind === "empty") {
    out.push({ level: "WARN", says: `${short(to)} has never been used on Pharos. Double-check it with the person: a wrong address can't be undone.` });
  } else if (out.every((v) => v.level !== "BLOCK")) {
    out.push({ level: "PASS", says: `${getAddress(to)} is ${describe(f)} on Pharos.` });
  }
  return out.sort((a, b) => rank(a) - rank(b));
}

const rank = (v: Verdict) => (v.level === "BLOCK" ? 0 : v.level === "WARN" ? 1 : 2);
