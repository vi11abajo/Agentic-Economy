// Telegram and Discord. The bot token and the webhook URL are secrets that sit inside URLs, so every error passes
// through redact() before it can be printed, and the values only ever come from siren's .env file or the
// environment, never from the command line.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { discordBody, telegramText, type Alert } from "./alert.js";

export interface Secrets {
  telegramToken?: string;
  telegramChatId?: string;
  discordWebhook?: string;
}

export const ENV_TEMPLATE = `# siren's channels. Fill what you use, leave the rest empty. This file stays on your machine.
# Telegram: token from @BotFather. After filling it, send /start to your bot and run: siren connect
SIREN_TELEGRAM_BOT_TOKEN=
SIREN_TELEGRAM_CHAT_ID=
# Discord: Server settings > Integrations > Webhooks > New webhook > Copy URL
SIREN_DISCORD_WEBHOOK=
`;

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

export const envFile = (home: string) => join(home, ".env");

export function ensureEnv(home: string): { path: string; created: boolean } {
  const path = envFile(home);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(home, { recursive: true });
  writeFileSync(path, ENV_TEMPLATE, { mode: 0o600 });
  return { path, created: true };
}

export function readSecrets(home: string, env: NodeJS.ProcessEnv = process.env): Secrets {
  const file = existsSync(envFile(home)) ? parseEnv(readFileSync(envFile(home), "utf8")) : {};
  const get = (k: string) => (env[k] || file[k] || "").trim() || undefined;
  return { telegramToken: get("SIREN_TELEGRAM_BOT_TOKEN"), telegramChatId: get("SIREN_TELEGRAM_CHAT_ID"), discordWebhook: get("SIREN_DISCORD_WEBHOOK") };
}

export function setSecret(home: string, key: string, value: string): void {
  const { path } = ensureEnv(home);
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join("\n"), { mode: 0o600 });
}

export function redact(text: string, s: Secrets): string {
  const parts = [s.discordWebhook, s.discordWebhook?.split("/").pop(), s.telegramToken].filter((x): x is string => !!x && x.length >= 6);
  let out = text;
  for (const p of parts.sort((a, b) => b.length - a.length)) out = out.split(p).join("<hidden>");
  return out;
}

export type Net = typeof fetch;

export interface Channel {
  name: "telegram" | "discord";
  send(a: Alert): Promise<void>;
}

export class DeliveryError extends Error {
  constructor(message: string, readonly hint: string, readonly retry: boolean) {
    super(message);
  }
}

const TG = "https://api.telegram.org/bot";

async function telegram(net: Net, s: Secrets, method: string, body: object): Promise<unknown> {
  let res: Response;
  try {
    res = await net(`${TG}${s.telegramToken}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new DeliveryError(redact(`Telegram did not answer: ${(e as Error).message}`, s), "no internet or Telegram is down; kept for the next round", true);
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (res.ok && j.ok) return j.result;
  const d = redact(j.description ?? `HTTP ${res.status}`, s);
  if (res.status === 401 || res.status === 404) throw new DeliveryError(`Telegram ${method}: ${d}`, "the bot token is wrong: copy it again from @BotFather", false);
  if (res.status === 403 || /chat not found|blocked|kicked/i.test(d)) throw new DeliveryError(`Telegram ${method}: ${d}`, "send /start to your bot, then run siren connect", false);
  throw new DeliveryError(`Telegram ${method}: ${d}`, res.status === 429 ? "Telegram asks to slow down; kept for the next round" : "Telegram refused it; kept for the next round", true);
}

const nap = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

// Discord answers 429 when a webhook posts faster than about 5 messages in 2 s (a --since replay does), and says in
// retry_after how long to wait. Waiting that long here beats leaving the alert for the next round.
const DISCORD_TRIES = 4;

export function channels(s: Secrets, net: Net = fetch, wait: (ms: number) => Promise<void> = nap): Channel[] {
  const out: Channel[] = [];
  if (s.telegramToken && s.telegramChatId) {
    out.push({
      name: "telegram",
      send: async (a) => {
        await telegram(net, s, "sendMessage", { chat_id: s.telegramChatId, text: telegramText(a), parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      },
    });
  }
  if (s.discordWebhook) {
    out.push({
      name: "discord",
      send: async (a) => {
        let res: Response;
        let text = "";
        for (let attempt = 1; ; attempt++) {
          try {
            res = await net(s.discordWebhook!, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(discordBody(a)) });
          } catch (e) {
            throw new DeliveryError(redact(`Discord did not answer: ${(e as Error).message}`, s), "no internet or Discord is down; kept for the next round", true);
          }
          if (res.ok) return;
          text = redact((await res.text().catch(() => "")).slice(0, 200), s);
          if (res.status !== 429 || attempt >= DISCORD_TRIES) break;
          let after = Number(res.headers.get("retry-after") ?? "1");
          try {
            after = Number((JSON.parse(text) as { retry_after?: number }).retry_after ?? after);
          } catch {
            // not JSON: keep the header's value
          }
          await wait(Math.min(Math.max(after, 0.2), 10) * 1000);
        }
        if (res.status === 401 || res.status === 404) throw new DeliveryError(`Discord webhook: HTTP ${res.status} ${text}`, "the webhook was deleted or the URL is wrong: make a new one", false);
        throw new DeliveryError(`Discord webhook: HTTP ${res.status} ${text}`, res.status === 429 ? "Discord still asks to slow down; kept for the next round" : "Discord refused it; kept for the next round", true);
      },
    });
  }
  return out;
}

/** The chat that last sent /start to the bot, or null. */
export async function findChat(net: Net, token: string): Promise<string | null> {
  const updates = (await telegram(net, { telegramToken: token }, "getUpdates", { limit: 100 })) as Array<{ message?: { text?: string; chat?: { id: number } } }>;
  const hit = [...updates].reverse().find((u) => u.message?.text?.startsWith("/start") && u.message.chat);
  return hit ? String(hit.message!.chat!.id) : null;
}
