// Typed reads and simulations on top of Chain, each one leaving a line of evidence: which contract, which call,
// at which block, what came back. A failed read stays a failure; it never becomes a zero.
import {
  decodeErrorResult,
  decodeFunctionResult,
  encodeFunctionData,
  keccak256,
  encodeAbiParameters,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import type { Chain, Overrides, Tx } from "./chain.js";
import { TOKEN_SLOTS } from "./venues.js";

export interface Evidence {
  what: string;
  contract: string;
  call: string;
  /** A block number for a read; "sim" for a simulation against the latest state with overrides. */
  block: number | "sim" | "latest";
  value: string;
}

export class Failed extends Error {
  constructor(readonly what: string, readonly reason: string) {
    super(`${what}: ${reason}`);
  }
}

// Errors we have actually met on these contracts, so a revert can be put in words.
const knownErrors = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  "error InvalidPhase(uint8)",
  "error EnforcedPause()",
  "error TransferFromReverted()",
  "error OwnableUnauthorizedAccount(address)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC4626ExceededMaxDeposit(address receiver, uint256 assets, uint256 max)",
  "error ERC4626ExceededMaxRedeem(address owner, uint256 shares, uint256 max)",
]);

export function explainRevert(data: Hex, message: string): string {
  if (data && data !== "0x" && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: knownErrors, data });
      if (d.errorName === "Error") {
        const text = String(d.args?.[0] ?? "");
        // Aave forks answer with bare numbered codes; we show the number rather than guess its meaning.
        return /^\d+$/.test(text) ? `Aave error code ${text}` : text;
      }
      return `${d.errorName}(${(d.args ?? []).map(String).join(", ")})`;
    } catch {
      return `custom error ${data.slice(0, 10)}`;
    }
  }
  return message.replace(/^execution reverted:?\s*/, "") || "reverted without a reason";
}

const pad = (a: string) => a.toLowerCase();

/** Storage overrides that give `owner` a token balance and an allowance for `spender`. */
export function tokenOverride(token: string, owner: string, amount: bigint, spender?: string): Overrides {
  const layout = TOKEN_SLOTS[token.toLowerCase()];
  if (!layout) throw new Error(`no storage layout known for ${token}`);
  const word = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}` as Hex;
  const mapSlot = (key: string, slot: Hex) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [pad(key) as Hex, slot]));
  const balanceBase = layout.kind === "solidity" ? word(layout.balance) : layout.base;
  const allowanceBase = layout.kind === "solidity" ? word(layout.allowance) : word(BigInt(layout.base) + 1n);
  const diff: Record<Hex, Hex> = { [mapSlot(owner, balanceBase)]: word(amount) };
  if (spender) diff[mapSlot(spender, mapSlot(owner, allowanceBase))] = word(amount);
  return { [token.toLowerCase()]: { stateDiff: diff } };
}

export function nativeOverride(owner: string, amount: bigint): Overrides {
  return { [owner.toLowerCase()]: { balance: `0x${amount.toString(16)}` as Hex } };
}

export function mergeOverrides(...all: Overrides[]): Overrides {
  const out: Overrides = {};
  for (const o of all)
    for (const [k, v] of Object.entries(o)) {
      const cur = out[k] ?? {};
      out[k] = { ...cur, ...v, stateDiff: { ...(cur.stateDiff ?? {}), ...(v.stateDiff ?? {}) } };
      if (!Object.keys(out[k].stateDiff!).length) delete out[k].stateDiff;
    }
  return out;
}

export class Reader {
  readonly evidence: Evidence[] = [];

  constructor(readonly chain: Chain) {}

  /** A view call at a block. Throws Failed with the decoded reason when it reverts. */
  async read<T = unknown>(what: string, to: string, abi: Abi, functionName: string, args: unknown[], block: number | "latest"): Promise<T> {
    const data = encodeFunctionData({ abi, functionName, args } as never);
    const r = await this.chain.call({ to, data }, block);
    const call = `${functionName}(${args.map(short).join(", ")})`;
    if (!r.ok) throw new Failed(what, `${call} on ${to} reverted: ${explainRevert(r.revert, r.message)}`);
    if (r.data === "0x") throw new Failed(what, `${call} on ${to} returned nothing`);
    const value = decodeFunctionResult({ abi, functionName, data: r.data } as never) as T;
    this.evidence.push({ what, contract: to, call, block, value: show(value) });
    return value;
  }

  /** A raw selector call, for getters that have no public name. */
  async readRaw(what: string, to: string, selector: Hex, block: number | "latest"): Promise<bigint> {
    const r = await this.chain.call({ to, data: selector }, block);
    if (!r.ok || r.data === "0x") throw new Failed(what, `${selector} on ${to} gave no answer`);
    const v = BigInt(r.data.slice(0, 66));
    this.evidence.push({ what, contract: to, call: `selector ${selector}()`, block, value: v.toString() });
    return v;
  }

  /** Runs a transaction as eth_call with overrides. Says whether it would go through and, if not, why. */
  async simulate(what: string, tx: Tx, overrides?: Overrides): Promise<{ ok: true; data: Hex } | { ok: false; why: string }> {
    const r = await this.chain.call(tx, "latest", overrides);
    const call = `${tx.data.slice(0, 10)} from ${tx.from ?? "?"}${tx.value ? ` with ${tx.value} wei` : ""}`;
    if (!r.ok) {
      const why = explainRevert(r.revert, r.message);
      this.evidence.push({ what, contract: tx.to, call, block: "sim", value: `reverts: ${why}` });
      return { ok: false, why };
    }
    this.evidence.push({ what, contract: tx.to, call, block: "sim", value: "goes through" });
    return { ok: true, data: r.data };
  }
}

function short(v: unknown): string {
  if (typeof v === "string" && v.startsWith("0x") && v.length === 42) return `${v.slice(0, 6)}...${v.slice(-4)}`;
  if (typeof v === "object" && v !== null) return "{...}";
  return String(v);
}

function show(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(show).join(", ")}]`;
  if (typeof v === "object" && v !== null) return `{${Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(", ")}}`;
  return String(v);
}
