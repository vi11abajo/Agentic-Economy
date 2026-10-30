// Turns revert data into a reason a person can read: Error(string), Panic(code), and the custom errors that
// show up on Pharos (OpenZeppelin ERC20/ownable errors, Prosper's router and market).
import { decodeAbiParameters, formatUnits, type Hex } from "viem";

const PANIC: Record<number, string> = {
  0x01: "assert failed",
  0x11: "arithmetic overflow or underflow",
  0x12: "division by zero",
  0x21: "bad enum value",
  0x22: "bad storage byte array",
  0x31: "pop on an empty array",
  0x32: "array index out of bounds",
  0x41: "out of memory",
  0x51: "call to an uninitialized function",
};

/** Custom errors by selector: name and argument types (decoded when they fit). Names from 4byte/openchain. */
export const CUSTOM: Record<string, { name: string; args: string[] }> = {
  "0xe450d38c": { name: "ERC20InsufficientBalance", args: ["address", "uint256", "uint256"] },
  "0xfb8f41b2": { name: "ERC20InsufficientAllowance", args: ["address", "uint256", "uint256"] },
  "0x96c6fd1e": { name: "ERC20InvalidSender", args: ["address"] },
  "0xec442f05": { name: "ERC20InvalidReceiver", args: ["address"] },
  "0xe602df05": { name: "ERC20InvalidApprover", args: ["address"] },
  "0x94280d62": { name: "ERC20InvalidSpender", args: ["address"] },
  "0x118cdaa7": { name: "OwnableUnauthorizedAccount", args: ["address"] },
  "0xd92e233d": { name: "ZeroAddress", args: [] },
  "0x7dd37f70": { name: "Slippage", args: [] },
  "0x1ab7da6b": { name: "DeadlineExpired", args: [] },
  "0x9db8d5b1": { name: "InvalidMarket", args: [] },
  "0x5274afe7": { name: "SafeERC20FailedOperation", args: ["address"] },
  "0x3ee5aeb5": { name: "ReentrancyGuardReentrantCall", args: [] },
  "0xd6bda275": { name: "FailedCall", args: [] },
};

export function decodeRevert(data: Hex | undefined, message?: string): string {
  if (!data || data === "0x" || data.length < 10) return message?.replace(/^execution reverted:?\s*/i, "").trim() || "reverted without a reason";
  const sel = data.slice(0, 10).toLowerCase();
  const body = `0x${data.slice(10)}` as Hex;
  try {
    if (sel === "0x08c379a0") return `Error("${decodeAbiParameters([{ type: "string" }], body)[0]}")`;
    if (sel === "0x4e487b71") {
      const code = Number(decodeAbiParameters([{ type: "uint256" }], body)[0]);
      return `Panic(0x${code.toString(16)}): ${PANIC[code] ?? "unknown panic code"}`;
    }
  } catch {
    // fall through to the selector
  }
  const c = CUSTOM[sel];
  if (!c) return `custom error ${sel} (not in the known list)`;
  try {
    const vals = decodeAbiParameters(c.args.map((type) => ({ type })), body).map(String);
    return `${c.name}(${vals.join(", ")})`;
  } catch {
    return `${c.name}()`;
  }
}

/** A line for ERC20InsufficientBalance that says it in token units, when the token is known. */
export function explainBalance(reason: string, symbol: string, decimals: number): string {
  const m = reason.match(/^ERC20InsufficientBalance\(0x[0-9a-fA-F]{40}, (\d+), (\d+)\)$/);
  return m ? `${reason}: has ${formatUnits(BigInt(m[1]), decimals)} ${symbol}, needs ${formatUnits(BigInt(m[2]), decimals)}` : reason;
}
