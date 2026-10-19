// Small persistent settings for rtfm (`rtfm verify on|off`). Stored as JSON in the user's config folder.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface Settings {
  verify: boolean;
}

const DEFAULTS: Settings = { verify: false };

/** RTFM_CONFIG wins; otherwise %APPDATA%\rtfm on Windows and $XDG_CONFIG_HOME (or ~/.config)/rtfm elsewhere. */
export function settingsPath(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.RTFM_CONFIG) return env.RTFM_CONFIG;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "rtfm", "config.json");
}

export function loadSettings(path = settingsPath()): Settings {
  if (!existsSync(path)) return { ...DEFAULTS };
  try {
    return { ...DEFAULTS, ...(JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>) };
  } catch {
    return { ...DEFAULTS }; // a broken file shouldn't break the CLI
  }
}

export function saveSettings(s: Settings, path = settingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
}
