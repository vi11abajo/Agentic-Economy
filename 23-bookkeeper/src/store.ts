// Everything the bookkeeper keeps lives in one data folder:
//   .env          the wallet key and the Telegram / Discord secrets (the user's, mode 600, never printed)
//   people.json   the address book: "Pete" -> 0x...
//   series.json   approved payment series
//   journal.jsonl every event, appended, never rewritten - the thing the agent reads to explain what happened
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Every } from "./period.js";

export type Hex = `0x${string}`;

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.BOOKKEEPER_HOME) return env.BOOKKEEPER_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "bookkeeper");
}

export const ENV_KEYS = {
  privateKey: "BOOKKEEPER_PRIVATE_KEY",
  telegramToken: "BOOKKEEPER_TELEGRAM_BOT_TOKEN",
  telegramChatId: "BOOKKEEPER_TELEGRAM_CHAT_ID",
  discordWebhook: "BOOKKEEPER_DISCORD_WEBHOOK",
} as const;

const envTemplate = (key: string) => `# The bookkeeper's own wallet. It pays from here, so keep only what the next payouts need on it.
# Made by \`bookkeeper init\`; you may replace it with a key of your own. Never share this file.
BOOKKEEPER_PRIVATE_KEY=${key}
# Telegram: bot token from @BotFather. Leave empty to skip Telegram.
BOOKKEEPER_TELEGRAM_BOT_TOKEN=
# Telegram chat id. Leave empty: \`bookkeeper notify-test\` finds it after you send /start to your bot.
BOOKKEEPER_TELEGRAM_CHAT_ID=
# Discord: webhook URL of your channel (https://discord.com/api/webhooks/...). Leave empty to skip Discord.
BOOKKEEPER_DISCORD_WEBHOOK=
`;

export interface Secrets {
  privateKey?: Hex;
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
}

const envPath = (home: string) => join(home, ".env");

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

export function readSecrets(home: string): Secrets {
  const path = envPath(home);
  const v = existsSync(path) ? parseEnv(readFileSync(path, "utf8")) : {};
  const get = (k: string) => v[k] || undefined;
  let key = get(ENV_KEYS.privateKey);
  if (key) {
    if (!key.startsWith("0x")) key = "0x" + key;
    // The message names the line, never the value.
    if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error(`${ENV_KEYS.privateKey} in ${path} is not a 32-byte hex key`);
  }
  return { privateKey: key as Hex | undefined, telegramToken: get(ENV_KEYS.telegramToken), telegramChatId: get(ENV_KEYS.telegramChatId), discordWebhook: get(ENV_KEYS.discordWebhook) };
}

/**
 * Makes the data folder and the .env. A key that is already there is never replaced (it may hold money); an .env
 * without a key gets one only when makeKey is given - `init --no-key` leaves the line empty for the user to paste.
 */
export function initHome(home: string, makeKey: (() => Hex) | null): { address: Hex | null; created: boolean; envPath: string } {
  mkdirSync(home, { recursive: true });
  const path = envPath(home);
  const have = readSecrets(home).privateKey;
  if (have) return { address: privateKeyToAccount(have).address, created: false, envPath: path };
  const key = makeKey ? makeKey() : "";
  if (existsSync(path)) {
    const text = readFileSync(path, "utf8");
    const line = new RegExp(`^\\s*${ENV_KEYS.privateKey}\\s*=.*$`, "m");
    writeFileSync(path, line.test(text) ? text.replace(line, `${ENV_KEYS.privateKey}=${key}`) : `${ENV_KEYS.privateKey}=${key}\n${text}`, { mode: 0o600 });
  } else writeFileSync(path, envTemplate(key), { mode: 0o600 });
  return { address: key ? privateKeyToAccount(key as Hex).address : null, created: !!key, envPath: path };
}

export interface Payee {
  name: string;
  address: Hex;
  amount: string; // decimal, in token units ("50", "0.01")
}

export interface Series {
  id: string;
  label: string;
  token: "USDC" | "PROS";
  payees: Payee[];
  every: Every;
  first: string; // wall clock of the first payment in tz, "2026-11-13T09:00"
  tz: string;
  checkEveryMinutes: number;
  status: "active" | "stopped";
  approvedAt: string;
  planId: string;
}

function readJson<T>(path: string, empty: T): T {
  return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as T) : empty;
}

/** Write to a side file and rename, so a crash never leaves half a JSON file behind. */
function writeJson(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value, null, 2) + "\n");
  renameSync(path + ".tmp", path);
}

export const loadSeries = (home: string) => readJson<Series[]>(join(home, "series.json"), []);
export const saveSeries = (home: string, s: Series[]) => (mkdirSync(home, { recursive: true }), writeJson(join(home, "series.json"), s));
export const loadPeople = (home: string) => readJson<Record<string, Hex>>(join(home, "people.json"), {});
export const savePeople = (home: string, p: Record<string, Hex>) => (mkdirSync(home, { recursive: true }), writeJson(join(home, "people.json"), p));

export type JournalKind = "approved" | "due" | "short" | "signed" | "sent" | "paid" | "failed" | "missed" | "notified" | "stopped" | "resumed";
export interface JournalEvent {
  at: string;
  series: string;
  period: number; // -1 for series-level events
  payee: number; // -1 for series-level events
  kind: JournalKind;
  [k: string]: unknown;
}

export function appendJournal(home: string, e: JournalEvent): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(join(home, "journal.jsonl"), JSON.stringify(e) + "\n");
}

export function readJournal(home: string): JournalEvent[] {
  const path = join(home, "journal.jsonl");
  if (!existsSync(path)) return [];
  const out: JournalEvent[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // a line cut short by a crash mid-write; everything before it is intact
    }
  }
  return out;
}
