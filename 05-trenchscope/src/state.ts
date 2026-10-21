// Positions (what you paid and how the market looked when you got in) and the log of every run.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Position } from "./checks.js";

const posFile = (home: string) => join(home, "positions.json");
const keyOf = (wallet: string, token: string) => `${wallet.toLowerCase()}:${token.toLowerCase()}`;

export function loadPositions(home: string): Record<string, Position> {
  const f = posFile(home);
  if (!existsSync(f)) return {};
  try {
    return JSON.parse(readFileSync(f, "utf8")) as Record<string, Position>;
  } catch {
    return {};
  }
}

export function getPosition(home: string, wallet: string, token: string): Position | null {
  return loadPositions(home)[keyOf(wallet, token)] ?? null;
}

export function putPosition(home: string, p: Position | null, wallet: string, token: string): void {
  const all = loadPositions(home);
  if (p) all[keyOf(wallet, token)] = p;
  else delete all[keyOf(wallet, token)];
  mkdirSync(home, { recursive: true });
  writeFileSync(posFile(home), `${JSON.stringify(all, null, 2)}\n`);
}

/** One JSON line per run: what was checked, every value, the decision, and the tx if one was sent. */
export function logRun(home: string, record: object): string {
  mkdirSync(home, { recursive: true });
  const f = join(home, "runs.jsonl");
  appendFileSync(f, `${JSON.stringify(record)}\n`);
  return f;
}

export function readRuns(home: string, last = 10): object[] {
  const f = join(home, "runs.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-last)
    .map((l) => JSON.parse(l) as object);
}
