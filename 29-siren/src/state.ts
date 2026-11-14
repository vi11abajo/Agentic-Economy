// What siren remembers between runs: where it stopped reading the chain, which events it already told you about,
// which price lines are armed, and alerts that still have to reach a channel. One JSON file in siren's own folder,
// outside the repo. Restarting siren never repeats an alert and never loses one.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Alert } from "./alert.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.SIREN_HOME) return env.SIREN_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "siren");
}

export interface Pending {
  alert: Alert;
  delivered: string[]; // channel names that already have it
  tries: number;
}

export interface State {
  lastBlock?: string;
  calls: Record<string, string>; // rule name -> last block already looked at
  price: Record<string, { armed: boolean; last?: number }>;
  seen: Record<string, number>; // alert id -> when it was queued (ms)
  outbox: Pending[];
}

// enough to cover days of alerts; older ids are far behind lastBlock and can't come back anyway
const KEEP_SEEN = 5000;

export const empty = (): State => ({ calls: {}, price: {}, seen: {}, outbox: [] });

export function loadState(file: string): State {
  if (!existsSync(file)) return empty();
  try {
    return { ...empty(), ...(JSON.parse(readFileSync(file, "utf8")) as Partial<State>) };
  } catch {
    throw new Error(`${file} is not readable JSON. Move it away to start fresh (siren will then alert on new events only)`);
  }
}

export function saveState(file: string, s: State): void {
  const ids = Object.entries(s.seen);
  if (ids.length > KEEP_SEEN) s.seen = Object.fromEntries(ids.sort((a, b) => b[1] - a[1]).slice(0, KEEP_SEEN));
  mkdirSync(join(file, ".."), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 1));
  renameSync(tmp, file);
}

/** Queues an alert unless this event was queued before. Returns false for a repeat. */
export function enqueue(s: State, a: Alert, now = Date.now()): boolean {
  if (s.seen[a.id]) return false;
  s.seen[a.id] = now;
  s.outbox.push({ alert: a, delivered: [], tries: 0 });
  return true;
}
