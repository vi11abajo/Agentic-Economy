// Getting an alert in front of a person. The console always gets it, stamped with the time. Telegram and Discord
// get it too when their secrets sit in <home>/.env. Both secrets live inside URLs, so every error we print goes
// through hide() first.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stamp } from "./render.js";

export const HOME = process.env.LASTCALL_HOME ?? ".lastcall";
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
  const p = join(home, ".env");
  if (existsSync(p)) {
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) file[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  const get = (k: string) => (process.env[k] || file[k] || undefined);
  return { telegramToken: get(ENV_KEYS.telegramToken), telegramChat: get(ENV_KEYS.telegramChat), discordWebhook: get(ENV_KEYS.discordWebhook) };
}

/** Writes an empty .env template the user can fill in themselves. Never overwrites. */
export function ensureEnvTemplate(home = HOME): string {
  mkdirSync(home, { recursive: true });
  const p = join(home, ".env");
  if (!existsSync(p)) writeFileSync(p, `${ENV_KEYS.telegramToken}=\n${ENV_KEYS.telegramChat}=\n${ENV_KEYS.discordWebhook}=\n`);
  return p;
}

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
