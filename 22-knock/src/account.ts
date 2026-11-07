// Who lives at an address, on one chain. The same 20 bytes can be three different things on Ethereum and on
// Pharos: a Safe on one and nothing at all on the other, which is exactly the trap a .eth name walks you into.
import { decodeAbiParameters, getAddress, type Hex } from "viem";
import type { Chain } from "./chain.js";

export interface SafeFacts {
  threshold: number;
  owners: number;
  version: string;
}

export interface AccountFacts {
  address: Hex;
  code: Hex;
  /** empty: no code and never sent a tx. eoa: a wallet with history. delegated: EIP-7702 wallet. contract: code. */
  kind: "empty" | "eoa" | "delegated" | "contract";
  nonce: number;
  balance: bigint;
  delegate?: Hex;
  safe?: SafeFacts;
}

const DELEGATION_PREFIX = "0xef0100";

async function readSafe(chain: Chain, a: Hex): Promise<SafeFacts | undefined> {
  // A Safe proxy keeps its singleton in slot 0 and answers getThreshold/getOwners/VERSION through it. If any of
  // that is missing, it's some other contract and we won't call it a Safe.
  const slot0 = await chain.storage(a, "0x0");
  if (BigInt(slot0) === 0n || BigInt(slot0) >> 160n !== 0n) return undefined;
  const [t, o, v] = await Promise.all([
    chain.call({ to: a, data: "0xe75235b8" }),
    chain.call({ to: a, data: "0xa0e67e2b" }),
    chain.call({ to: a, data: "0xffa1ad74" }),
  ]);
  if (!t.ok || !o.ok || !v.ok || t.data === "0x" || o.data === "0x" || v.data === "0x") return undefined;
  try {
    const [owners] = decodeAbiParameters([{ type: "address[]" }], o.data);
    const [version] = decodeAbiParameters([{ type: "string" }], v.data);
    return { threshold: Number(BigInt(t.data)), owners: owners.length, version };
  } catch {
    return undefined;
  }
}

export async function accountFacts(chain: Chain, address: string): Promise<AccountFacts> {
  const a = address.toLowerCase() as Hex;
  const [code, nonce, balance] = await Promise.all([chain.code(a), chain.nonce(a), chain.nativeBalance(a)]);
  if (code.toLowerCase().startsWith(DELEGATION_PREFIX) && code.length === 2 + 46) {
    return { address: a, code, kind: "delegated", nonce, balance, delegate: `0x${code.slice(8).toLowerCase()}` as Hex };
  }
  if (code !== "0x") return { address: a, code, kind: "contract", nonce, balance, safe: await readSafe(chain, a) };
  return { address: a, code, kind: nonce > 0 ? "eoa" : "empty", nonce, balance };
}

export const short = (a: string) => {
  const c = getAddress(a);
  return `${c.slice(0, 6)}...${c.slice(-4)}`;
};

/** A few words for what the facts say, used in summaries. */
export function describe(f: AccountFacts): string {
  if (f.safe) return `a ${f.safe.threshold}-of-${f.safe.owners} Safe multisig (v${f.safe.version})`;
  if (f.kind === "contract") return "a contract";
  if (f.kind === "delegated") return `a wallet delegated by EIP-7702 to ${short(f.delegate!)}`;
  if (f.kind === "eoa") return `a wallet that has sent ${f.nonce} transaction${f.nonce === 1 ? "" : "s"}`;
  return f.balance > 0n ? "an address that has never sent a transaction (it holds some PROS)" : "an address that has never been used";
}
