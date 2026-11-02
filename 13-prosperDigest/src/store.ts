// Everything prosperDigest keeps lives in one data folder: .env (the user's bot token / webhook, filled by the
// user), config.json, history.jsonl, markets.json, traders.json, reports/ and run.log.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Digest } from "./types.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.PROSPERDIGEST_HOME) return env.PROSPERDIGEST_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "prosperDigest");
}

export const ENV_KEYS = {
  telegramToken: "PROSPERDIGEST_TELEGRAM_BOT_TOKEN",
  telegramChatId: "PROSPERDIGEST_TELEGRAM_CHAT_ID",
  discordWebhook: "PROSPERDIGEST_DISCORD_WEBHOOK",
} as const;

export const ENV_TEMPLATE = `# Telegram: bot token from @BotFather (looks like 123456:ABC...). Leave empty to skip Telegram.
PROSPERDIGEST_TELEGRAM_BOT_TOKEN=
# Telegram chat id. Leave empty: \`prosperDigest test\` finds it after you send /start to your bot.
PROSPERDIGEST_TELEGRAM_CHAT_ID=
# Discord: webhook URL of your channel (https://discord.com/api/webhooks/...). Leave empty to skip Discord.
PROSPERDIGEST_DISCORD_WEBHOOK=
`;

export interface Secrets {
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
}

const envPath = (home: string) => join(home, ".env");

export function ensureEnv(home: string): { path: string; created: boolean } {
  mkdirSync(home, { recursive: true });
  const path = envPath(home);
  if (existsSync(path)) return { path, created: false };
  writeFileSync(path, ENV_TEMPLATE, { mode: 0o600 });
  return { path, created: true };
}

/** KEY=value lines, # comments, optional quotes, CRLF; values trimmed, empty means unset. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return out;
}

export function readEnv(home: string): Secrets {
  const path = envPath(home);
  const v = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const get = (k: string) => v[k] || undefined;
  return { telegramToken: get(ENV_KEYS.telegramToken), telegramChatId: get(ENV_KEYS.telegramChatId), discordWebhook: get(ENV_KEYS.discordWebhook) };
}

/** Replaces only this key's line (or appends it); comments and other lines stay as they are. */
export function setEnvValue(home: string, key: string, value: string): void {
  const path = ensureEnv(home).path;
  const text = readFileSync(path, "utf8");
  const re = new RegExp(`^(\\s*${key}\\s*=).*$`, "m");
  writeFileSync(path, re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, "\n")}${key}=${value}\n`);
}

export interface Schedule {
  days: number; // period length and run interval
  weekday: number; // 0 Sun .. 6 Sat, used when days = 7
  time: string; // HH:MM in tz
  tz: string;
  anchor: string; // YYYY-MM-DD, a UTC midnight that starts a period
}

export interface Config {
  channels: { telegram: boolean; discord: boolean };
  schedule: Schedule;
  topTokens: number;
}

export const DEFAULT_CONFIG: Config = {
  channels: { telegram: false, discord: false },
  schedule: { days: 7, weekday: 1, time: "09:00", tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", anchor: "2026-01-05" },
  topTokens: 20,
};

export function loadConfig(home: string): Config {
  const c = readJson<Partial<Config>>(home, "config.json", {});
  return { ...DEFAULT_CONFIG, ...c, channels: { ...DEFAULT_CONFIG.channels, ...c.channels }, schedule: { ...DEFAULT_CONFIG.schedule, ...c.schedule } };
}

export function saveConfig(home: string, c: Config): void {
  writeJson(home, "config.json", c);
}

export function readJson<T>(home: string, name: string, fallback: T): T {
  const f = join(home, name);
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : fallback;
}

/** Written to a temp file and renamed, so a crash never leaves half a file. */
export function writeJson(home: string, name: string, value: unknown): void {
  mkdirSync(home, { recursive: true });
  const f = join(home, name);
  writeFileSync(`${f}.tmp`, JSON.stringify(value, null, 1));
  renameSync(`${f}.tmp`, f);
}

export function readHistory(home: string): Digest[] {
  const f = join(home, "history.jsonl");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Digest);
}

export function appendHistory(home: string, d: Digest): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "history.jsonl"), `${JSON.stringify(d)}\n`);
}

/** Rewrites history with this digest in place of the one with the same key (or appended). */
export function putHistory(home: string, d: Digest): void {
  const all = readHistory(home);
  const i = all.findIndex((x) => x.key === d.key);
  if (i >= 0) all[i] = d;
  else all.push(d);
  mkdirSync(home, { recursive: true });
  const f = join(home, "history.jsonl");
  writeFileSync(`${f}.tmp`, all.map((x) => JSON.stringify(x)).join("\n") + "\n");
  renameSync(`${f}.tmp`, f);
}

export function log(home: string, line: string): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "run.log"), `${new Date().toISOString()} ${line}\n`);
}
