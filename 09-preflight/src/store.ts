// Where preflight keeps its things: settings, the key (.env) and a journal of every simulation and
// every send.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { DEFAULTS, type Settings } from "./sim.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.PREFLIGHT_HOME) return env.PREFLIGHT_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "preflight");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).replace(/\\/g, "/");
}

export function loadSettings(home: string): Settings {
  const f = join(home, "config.json");
  if (!existsSync(f)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...(JSON.parse(readFileSync(f, "utf8")) as Partial<Settings>) };
}

export function saveSettings(home: string, s: Settings): string {
  mkdirSync(home, { recursive: true });
  const f = join(home, "config.json");
  writeFileSync(f, `${JSON.stringify(s, null, 2)}\n`);
  return f;
}

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** The signing key, from .env in the data folder or the environment. Never printed. */
export function signer(home: string, env: NodeJS.ProcessEnv = process.env): Account | null {
  const file = env.PREFLIGHT_ENV_FILE || join(home, ".env"); // PREFLIGHT_ENV_FILE: an .env kept somewhere else
  const vars = { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...env } as Record<string, string | undefined>;
  const pk = vars.PREFLIGHT_PRIVATE_KEY || vars.PRIVATE_KEY;
  if (pk) {
    const hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY in .env doesn't look like a 32-byte hex key");
    return privateKeyToAccount(hex);
  }
  const phrase = vars.PREFLIGHT_MNEMONIC || vars.MNEMONIC;
  return phrase ? mnemonicToAccount(phrase.trim(), { addressIndex: Number(vars.MNEMONIC_INDEX ?? 0) }) : null;
}

export function journal(home: string, event: Record<string, unknown>): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "journal.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`);
}

export function readJournal(home: string): Record<string, unknown>[] {
  const f = join(home, "journal.jsonl");
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : [];
}
