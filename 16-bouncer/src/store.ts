// Where bouncer keeps the user's key: a .env in its own data folder, written by the user, read only by send. The
// key is never printed, never taken from the command line, never echoed back in an error.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.BOUNCER_HOME) return env.BOUNCER_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "bouncer");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).split("\\").join("/");
}

/** Minimal .env reader: KEY=value lines, # comments, optional quotes and `export`. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export function loadAccount(home: string): LocalAccount | null {
  const file = join(home, ".env");
  if (!existsSync(file)) return null;
  const pk = parseEnv(readFileSync(file, "utf8")).PRIVATE_KEY;
  if (!pk) return null;
  const hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error(`PRIVATE_KEY in ${displayPath(file)} doesn't look like a 32-byte hex key`);
  return privateKeyToAccount(hex);
}
