// The optional signing key. It is read from a .env file in the trenchscope folder (or the environment),
// never from the command line or the chat, and never printed. Without it trenchscope only advises.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Account } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadEnv(home: string, env: NodeJS.ProcessEnv = process.env): Record<string, string | undefined> {
  const file = join(home, ".env");
  const fromFile = existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
  return { ...fromFile, ...env };
}

export function signer(env: Record<string, string | undefined>): Account | null {
  const pk = env.TRENCHSCOPE_PRIVATE_KEY || env.PRIVATE_KEY;
  if (pk) {
    const hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY in .env doesn't look like a 32-byte hex key");
    return privateKeyToAccount(hex);
  }
  const phrase = env.TRENCHSCOPE_MNEMONIC || env.MNEMONIC;
  if (phrase) return mnemonicToAccount(phrase.trim(), { addressIndex: Number(env.MNEMONIC_INDEX ?? 0) });
  return null;
}
