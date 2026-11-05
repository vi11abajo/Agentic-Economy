import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Where receipts keeps its notebook: explorer history, cached tx receipts, saved scans. */
export function dataHome(): string {
  if (process.env.RECEIPTS_HOME) return process.env.RECEIPTS_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "receipts");
  return join(homedir(), ".config", "receipts");
}

export function readJson<T>(rel: string, fallback: T): T {
  const path = join(dataHome(), rel);
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Writes to a temp file first and renames, so a Ctrl+C halfway never leaves half a JSON behind. */
export function writeJson(rel: string, value: unknown): void {
  const path = join(dataHome(), rel);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  renameSync(tmp, path);
}
