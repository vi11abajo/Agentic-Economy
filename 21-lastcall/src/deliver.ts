// Getting an alert in front of a person. The console always gets it, stamped with the time. Telegram and Discord
// get it too as soon as their lines in the skill's alerts.env are filled in. Both secrets live inside URLs, so
// every error we print goes through hide() first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stamp } from "./render.js";

// The skill folder (the one with SKILL.md). The bundled CLI sits in <skill>/scripts/, the dev build in dist/.
const here = dirname(fileURLToPath(import.meta.url));
export const SKILL_DIR = basename(here) === "scripts" ? dirname(here) : join(here, "..", "skill", "lastcall");
/** alerts.env lives here; LASTCALL_HOME moves it (and the watch state) elsewhere. */
export const HOME = process.env.LASTCALL_HOME ?? SKILL_DIR;
export const ENV_FILE = "alerts.env";
/** Watch memory (levels already alerted), kept apart from the secrets. */
export const STATE_DIR = join(HOME, ".state");
export const ENV_KEYS = {
  telegramToken: "LASTCALL_TELEGRAM_BOT_TOKEN",
  telegramChat: "LASTCALL_TELEGRAM_CHAT_ID",
  discordWebhook: "LASTCALL_DISCORD_WEBHOOK",
} as const;

export interface Secrets {
  telegramToken?: string;
  telegramChat?: string;
  discordWebhook?: string;
}

/** Process env wins over the file, so a CI or a shell export can override. */
export function loadSecrets(home = HOME): Secrets {
  const file: Record<string, string> = {};
  const p = join(home, ENV_FILE);
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) file[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const get = (k: string) => (process.env[k] || file[k] || undefined);
  return { telegramToken: get(ENV_KEYS.telegramToken), telegramChat: get(ENV_KEYS.telegramChat), discordWebhook: get(ENV_KEYS.discordWebhook) };
}

export const ENV_TEMPLATE = `# lastcall alerts: where to send them besides the console.
# Fill Telegram, Discord or both. An empty line means that channel is off. Paste each value right after
# the "=", no quotes, no spaces. This file holds secrets: don't share it, don't commit it.

# Telegram, line 1: the token @BotFather gives you for your bot, looks like 1234567890:AAH...
${ENV_KEYS.telegramToken}=
# Telegram, line 2: leave it empty. After you press Start in your bot's chat, "lastcall channels test"
# finds your chat and writes its id here by itself.
${ENV_KEYS.telegramChat}=

# Discord: the channel's webhook URL, looks like https://discord.com/api/webhooks/<numbers>/<secret>
${ENV_KEYS.discordWebhook}=
`;

/** Makes sure the template is there for the user to fill in. Never overwrites a filled file. */
export function ensureEnvTemplate(home = HOME): string {
  mkdirSync(home, { recursive: true });
  const p = join(home, ENV_FILE);
  if (!existsSync(p)) writeFileSync(p, ENV_TEMPLATE);
  return p;
}

/** Which channels are switched on just by being filled in. */
export const channelsOn = (s: Secrets) => ({ telegram: !!(s.telegramToken && s.telegramChat), discord: !!s.discordWebhook });

export function hide(text: string, s: Secrets): string {
  let out = text;
  for (const secret of [s.discordWebhook, s.discordWebhook?.split("/").pop(), s.telegramToken].filter((x): x is string => !!x && x.length >= 6)) {
    out = out.split(secret).join("<hidden>");
  }
  return out;
}

export type Net = typeof fetch;

export async function toTelegram(net: Net, s: Secrets, text: string): Promise<void> {
  const res = await net(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: s.telegramChat, text, link_preview_options: { is_disabled: true } }),
  });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
  if (!res.ok || !j.ok) throw new Error(hide(`Telegram said: ${j.description ?? `HTTP ${res.status}`}`, s));
}

/** The chat that last sent /start to the bot, so the user doesn't have to dig out a chat id by hand. */
export async function findTelegramChat(net: Net, token: string): Promise<string | null> {
  const res = await net(`https://api.telegram.org/bot${token}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: Array<{ message?: { text?: string; chat?: { id: number } } }>; description?: string };
  if (!j.ok) throw new Error(hide(`Telegram said: ${j.description ?? `HTTP ${res.status}`}`, { telegramToken: token }));
  const hit = [...(j.result ?? [])].reverse().find((u) => u.message?.text?.startsWith("/start") && u.message.chat);
  return hit ? String(hit.message!.chat!.id) : null;
}

export async function toDiscord(net: Net, s: Secrets, text: string): Promise<void> {
  // Discord caps a message at 2000 characters; alerts are shorter, but cut cleanly just in case.
  const content = text.length > 1990 ? `${text.slice(0, 1985)}…` : text;
  const res = await net(`${s.discordWebhook}?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content }) });
  if (!res.ok) {
    const j = (await res.json().catch(() => ({}))) as { message?: string };
    throw new Error(hide(`Discord said: ${j.message ?? `HTTP ${res.status}`}`, s));
  }
}

export interface Outlet {
  console: (line: string) => void;
  net: Net;
  secrets: Secrets;
  telegram: boolean;
  discord: boolean;
}

/** Sends one alert everywhere it should go; returns what happened per channel, failures included. */
export async function shout(o: Outlet, text: string, when = new Date()): Promise<string[]> {
  const t = stamp(when);
  o.console(text.split("\n").map((l, i) => (i === 0 ? `${t} ${l}` : `${" ".repeat(t.length)} ${l}`)).join("\n"));
  const report: string[] = [];
  const body = `${t} ${text}`;
  if (o.telegram) {
    if (!o.secrets.telegramToken || !o.secrets.telegramChat) report.push("telegram: not set up (token or chat id missing)");
    else await toTelegram(o.net, o.secrets, body).then(() => report.push("telegram: delivered"), (e: Error) => report.push(`telegram: FAILED, ${e.message}`));
  }
  if (o.discord) {
    if (!o.secrets.discordWebhook) report.push("discord: not set up (webhook missing)");
    else await toDiscord(o.net, o.secrets, body).then(() => report.push("discord: delivered"), (e: Error) => report.push(`discord: FAILED, ${e.message}`));
  }
  return report;
}
