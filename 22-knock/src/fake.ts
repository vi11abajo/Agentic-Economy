// A pretend chain for the tests: a handful of accounts with code, nonce and answers to a few calls. Anything the
// test didn't set up behaves like an untouched address.
import type { Hex } from "viem";
import type { CallFrame, CallResult, Chain, Receipt, Tx } from "./chain.js";

export interface FakeAccount {
  code?: Hex;
  nonce?: number;
  balance?: bigint;
  storage?: Record<string, Hex>;
  /** selector (first 4 bytes of calldata, lower case) -> answer */
  answers?: Record<string, CallResult>;
}

export function fakeChain(accounts: Record<string, FakeAccount>, extra: Partial<Chain> = {}): Chain {
  const get = (a: string) => accounts[a.toLowerCase()] ?? {};
  const base: Chain = {
    head: async () => 22_400_000,
    call: async (tx: Tx): Promise<CallResult> => {
      const sel = (tx.data ?? "0x").slice(0, 10).toLowerCase();
      return get(tx.to).answers?.[sel] ?? { ok: true, data: "0x" };
    },
    estimateGas: async () => ({ ok: true, data: "0x", gas: 50_000n }),
    gasPrice: async () => 10_000_000_000n,
    nativeBalance: async (a) => get(a).balance ?? 0n,
    code: async (a) => get(a).code ?? "0x",
    nonce: async (a) => get(a).nonce ?? 0,
    storage: async (a, slot) => get(a).storage?.[slot.toLowerCase()] ?? `0x${"0".repeat(64)}`,
    trace: async (): Promise<CallFrame | null> => null,
    receipt: async (): Promise<Receipt | null> => null,
    txInput: async () => null,
  };
  return { ...base, ...extra };
}

export const word = (n: bigint | number) => `0x${BigInt(n).toString(16).padStart(64, "0")}` as Hex;
export const addrWord = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
