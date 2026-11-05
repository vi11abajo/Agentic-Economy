import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Brief } from "./docs.js";
import type { Sheet } from "./subjects.js";

/** Where nerd keeps what it read and what it called: NERD_HOME, else the usual per-user config folder. */
export function nerdHome(): string {
  if (process.env.NERD_HOME) return process.env.NERD_HOME;
  if (process.platform === "win32" && process.env.APPDATA) return join(process.env.APPDATA, "nerd");
  return join(homedir(), ".config", "nerd");
}

/** How old a docs brief may be and still count as "read before the call". */
export const BRIEF_SHELF_LIFE_MS = 60 * 60 * 1000;

function fileFor(kind: "briefs" | "sheets", key: string): string {
  const dir = join(nerdHome(), kind);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${key.replace(/[^a-zA-Z0-9_.-]/g, "_")}.json`);
}

function writeWhole(path: string, body: unknown): void {
  // Write next to it, then rename, so a crash never leaves half a brief that looks like a whole one.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(body, null, 2));
  renameSync(tmp, path);
}

export function saveBrief(brief: Brief): string {
  const path = fileFor("briefs", brief.key);
  writeWhole(path, brief);
  return path;
}

export function loadBrief(key: string): Brief | undefined {
  const path = fileFor("briefs", key);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Brief) : undefined;
}

export function saveSheet(sheet: Sheet): string {
  const path = fileFor("sheets", sheet.key);
  writeWhole(path, sheet);
  return path;
}

export function loadSheet(key: string): Sheet | undefined {
  const path = fileFor("sheets", key);
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Sheet) : undefined;
}

/** Why the chain step may not run yet, or undefined when the docs were read recently enough. */
export function docsFirstProblem(brief: Brief | undefined, now = Date.now()): string | undefined {
  if (!brief) return "the docs were not read for this yet: run `nerd docs` with the same target first";
  if (now - brief.madeAt > BRIEF_SHELF_LIFE_MS) return "the docs brief is older than an hour: run `nerd docs` again first";
  return undefined;
}
