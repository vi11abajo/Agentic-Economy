// Keys live in env files outside the repo, never in code, prompts or logs. We read them, turn them into viem
// accounts and only ever print the address.
import { existsSync, readFileSync } from "node:fs";
import { privateKeyToAccount, nonceManager } from "viem/accounts";
import type { Account, Hex } from "viem";

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * Looks for `names` first in the process environment, then in `file` (if given). Returns null when there's no key,
 * so the caller can say which file or variable to set instead of crashing.
 */
export function loadAccount(names: string[], file?: string, withNonceManager = false): Account | null {
  const fromFile = file && existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  const raw = names.map((n) => process.env[n] ?? fromFile[n]).find(Boolean);
  if (!raw) return null;
  const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${names.join("/")} doesn't look like a 32-byte hex key`);
  // The facilitator sends one tx per sale; counting nonces locally avoids a stale count from a lagging node.
  return privateKeyToAccount(key, withNonceManager ? { nonceManager } : undefined);
}
