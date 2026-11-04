// The data folder: config.json with the caps, the key in .env (written by the user, read only here, never
// printed), and one JSON per draw so a crash halfway can be picked up again with --resume.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { LocalAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { DEFAULT_CAPS, type Caps } from "./params.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.KICKBACK_HOME) return env.KICKBACK_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "kickback");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).split("\\").join("/");
}

/** The caps live in config.json. First run writes the defaults so the user has a file to edit. */
export function loadCaps(home: string): Caps {
  const file = join(home, "config.json");
  if (!existsSync(file)) {
    mkdirSync(home, { recursive: true });
    writeFileSync(file, `${JSON.stringify(DEFAULT_CAPS, null, 2)}\n`);
    return { ...DEFAULT_CAPS };
  }
  return { ...DEFAULT_CAPS, ...(JSON.parse(readFileSync(file, "utf8")) as Partial<Caps>) };
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

// JSON can't hold bigints, so they travel as {"$big": "123"} and come back as 123n.
const toJson = (value: unknown) => JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? { $big: v.toString() } : v), 2);
const fromJson = <T>(text: string): T =>
  JSON.parse(text, (_k, v) => (v && typeof v === "object" && typeof v.$big === "string" && Object.keys(v).length === 1 ? BigInt(v.$big) : v)) as T;

export function saveDraw(home: string, commitTx: string, state: unknown): void {
  const dir = join(home, "draws");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${commitTx}.json`), `${toJson(state)}\n`);
}

const stillRunning = (pid: number) => {
  try {
    process.kill(pid, 0); // signal 0 only asks "are you there?"
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One process per draw. Two of them on the same draw could each sign a payout for the same winner with different
 * nonces, and then both land. A lock left by a process that died is taken over. Returns the release function.
 */
export function holdDraw(home: string, commitTx: string): () => void {
  const dir = join(home, "draws");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${commitTx}.lock`);
  for (let attempt = 0; ; attempt++) {
    try {
      const fd = openSync(file, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt > 0) throw err;
      const holder = Number(readFileSync(file, "utf8").trim());
      if (holder && stillRunning(holder)) throw new Error(`draw ${commitTx} is already running in process ${holder}; let it finish first`);
      rmSync(file, { force: true });
    }
  }
}

export function loadDraw<T>(home: string, commitTx: string): T | null {
  const file = join(home, "draws", `${commitTx}.json`);
  return existsSync(file) ? fromJson<T>(readFileSync(file, "utf8")) : null;
}

export function appendHistory(home: string, state: unknown): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "draws.jsonl"), `${JSON.stringify(JSON.parse(toJson(state)))}\n`);
}
