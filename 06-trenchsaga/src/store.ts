// Where trenchsaga keeps its things: settings, the key (.env), each saga's state and the journal of every
// transition. The state file is rewritten after every transition, so it always shows the current step.
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Account } from "viem";
import { mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import type { SagaState } from "./saga.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TRENCHSAGA_HOME) return env.TRENCHSAGA_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "trenchsaga");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).replace(/\\/g, "/");
}

// JSON with bigints: written as {"$big": "123"} and read back as bigint.
export const toJson = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? { $big: x.toString() } : x), 2);
export const fromJson = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (x && typeof x === "object" && typeof x.$big === "string" && Object.keys(x).length === 1 ? BigInt(x.$big) : x)) as T;

export interface Settings {
  max_buy_pros: number;
  slippage_pct: number;
  max_attempts: number;
  receipt_timeout_sec: number;
}
export const DEFAULTS: Settings = { max_buy_pros: 0.01, slippage_pct: 2, max_attempts: 3, receipt_timeout_sec: 30 };

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
  const file = join(home, ".env");
  const vars = { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...env } as Record<string, string | undefined>;
  const pk = vars.TRENCHSAGA_PRIVATE_KEY || vars.PRIVATE_KEY;
  if (pk) {
    const hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as `0x${string}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY in .env doesn't look like a 32-byte hex key");
    return privateKeyToAccount(hex);
  }
  const phrase = vars.TRENCHSAGA_MNEMONIC || vars.MNEMONIC;
  return phrase ? mnemonicToAccount(phrase.trim(), { addressIndex: Number(vars.MNEMONIC_INDEX ?? 0) }) : null;
}

const sagaDir = (home: string) => join(home, "sagas");

export function saveState(home: string, s: SagaState<unknown>): void {
  mkdirSync(sagaDir(home), { recursive: true });
  const f = join(sagaDir(home), `${s.id}.json`);
  writeFileSync(`${f}.tmp`, toJson(s));
  renameSync(`${f}.tmp`, f); // never leave a half-written state file behind
}

export function loadState<C>(home: string, id: string): SagaState<C> {
  return fromJson<SagaState<C>>(readFileSync(join(sagaDir(home), `${id}.json`), "utf8"));
}

/** Saga ids sort by time, so the last one is the newest. */
export function listSagas(home: string): string[] {
  if (!existsSync(sagaDir(home))) return [];
  return readdirSync(sagaDir(home)).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
}

export function journal(home: string, echo?: (e: Record<string, unknown>) => void) {
  mkdirSync(home, { recursive: true });
  const f = join(home, "saga.jsonl");
  return (event: Record<string, unknown>) => {
    const e = { at: new Date().toISOString(), ...event };
    appendFileSync(f, `${JSON.stringify(e, (_k, x) => (typeof x === "bigint" ? x.toString() : x))}\n`);
    echo?.(e);
  };
}

export function readJournal(home: string, sagaId?: string): Record<string, unknown>[] {
  const f = join(home, "saga.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>).filter((e) => !sagaId || e.saga === sagaId);
}
