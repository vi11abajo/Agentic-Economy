// The two raw clues a failed transaction leaves behind: the bytes it reverted with, and the call trace that shows
// which contract deep inside actually said no.
import { decodeErrorResult, parseAbi, type Hex } from "viem";

// Errors we've met on Pharos (or that every token speaks). Anything else gets a name from the public 4byte list
// in autopsy.ts, when somebody published it.
export const FAMILIAR_ERRORS = parseAbi([
  "error Error(string)",
  "error Panic(uint256)",
  "error Slippage()",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error TransferReverted()",
  "error TransferFromReverted()",
  "error Unauthorized()",
  "error OwnableUnauthorizedAccount(address account)",
  "error SafeERC20FailedOperation(address token)",
]);

export interface Revert {
  /** "silence" when there were no bytes at all, "unknown" when we can't name the selector yet. */
  name: string;
  selector: string;
  message?: string;
  args: readonly unknown[];
}

const PANIC_REASONS: Record<number, string> = {
  0x01: "an assert failed",
  0x11: "a number overflowed or underflowed",
  0x12: "division by zero",
  0x32: "an array was read past its end",
};

export function readTheRevert(bytes: string | undefined | null): Revert {
  if (!bytes || bytes === "0x") return { name: "silence", selector: "0x", args: [] };
  const selector = bytes.slice(0, 10);
  try {
    const { errorName, args = [] } = decodeErrorResult({ abi: FAMILIAR_ERRORS, data: bytes as Hex });
    if (errorName === "Error") return { name: "Error", message: String(args[0]), selector, args: [] };
    if (errorName === "Panic") {
      const code = Number(args[0]);
      return { name: "Panic", message: PANIC_REASONS[code] ?? `panic code 0x${code.toString(16)}`, selector, args: [] };
    }
    return { name: errorName, selector, args };
  } catch {
    return { name: "unknown", selector, args: [] };
  }
}

/** One frame of debug_traceTransaction's callTracer output. */
export interface CallFrame {
  type: string;
  from: string;
  to: string;
  input: string;
  output?: string;
  error?: string;
  gas?: string;
  gasUsed?: string;
  value?: string;
  calls?: CallFrame[];
}

export interface BreakingPoint extends CallFrame {
  /** 0 is the transaction itself; deeper means the "no" came from a contract it called. */
  depth: number;
  /** The frames from the top down to here, handy for "router -> pool -> token" in the explanation. */
  path: CallFrame[];
}

/**
 * Follow the failing calls down until there's nothing deeper that failed: that's where it really broke. Contracts
 * often try something, catch the failure and move on (routers trying pools, optional decimals() probes), so a failed
 * child isn't always the culprit. We prefer the child whose revert the parent passed on word for word, and otherwise
 * the last one that failed, since the revert that killed the call comes after anything that was caught.
 */
export function whereItBroke(top: CallFrame): BreakingPoint {
  const path: CallFrame[] = [top];
  let here = top;
  for (;;) {
    const failed = here.calls?.filter((c) => c.error) ?? [];
    const deeperFailure = failed.find((c) => c.output && c.output !== "0x" && c.output === here.output) ?? failed.at(-1);
    if (!deeperFailure) break;
    path.push(deeperFailure);
    here = deeperFailure;
  }
  return { ...here, from: here.from.toLowerCase(), to: here.to?.toLowerCase(), depth: path.length - 1, path };
}
