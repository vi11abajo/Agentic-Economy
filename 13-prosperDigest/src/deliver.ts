// Delivery to the user's own Telegram bot and Discord webhook. Both carry a secret in the URL, so every error
// message goes through redact() before anyone can print it.
import type { Secrets } from "./store.js";

export type Net = typeof fetch;
export interface Attachment {
  name: string;
  body: string;
}

export class DeliveryError extends Error {
  constructor(readonly channel: "telegram" | "discord", message: string, readonly hint: string) {
    super(message);
  }
}

/** Removes the bot token, the webhook URL and the webhook's secret part from a text. */
export function redact(text: string, s: Secrets): string {
  let out = text;
  const parts = [s.discordWebhook, s.discordWebhook?.split("/").pop(), s.telegramToken].filter((x): x is string => !!x && x.length >= 6);
  for (const p of parts.sort((a, b) => b.length - a.length)) out = out.split(p).join("<hidden>");
  return out;
}

const TG = "https://api.telegram.org/bot";

async function tg(net: Net, s: Secrets, method: string, body: object | FormData): Promise<unknown> {
  const token = s.telegramToken!;
  let res: Response;
  try {
    res = await net(`${TG}${token}/${method}`, body instanceof FormData ? { method: "POST", body } : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (e) {
    throw new DeliveryError("telegram", redact(`Telegram did not answer: ${(e as Error).message}`, s), "check the internet connection; the send is retried");
  }
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string; result?: unknown };
  if (res.ok && j.ok) return j.result;
  const d = j.description ?? `HTTP ${res.status}`;
  const hint =
    res.status === 401 || res.status === 404 ? "the bot token is wrong: copy it again from @BotFather"
    : /chat not found|bot was blocked|forbidden|not a member|kicked/i.test(d) || res.status === 403 ? "send /start to your bot (or add it to the group) first"
    : res.status === 429 ? "Telegram asks to slow down; the send is retried"
    : "Telegram refused the message";
  throw new DeliveryError("telegram", redact(`Telegram ${method}: ${d}`, s), hint);
}

/** The summary (when text is given), then the report file (when given). Callers retry the two parts separately. */
export async function sendTelegram(net: Net, s: Secrets, text: string | null, file?: Attachment): Promise<void> {
  if (text !== null) await tg(net, s, "sendMessage", { chat_id: s.telegramChatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  if (file) {
    const form = new FormData();
    form.set("chat_id", String(s.telegramChatId));
    form.set("document", new Blob([file.body], { type: "text/html" }), file.name);
    await tg(net, s, "sendDocument", form);
  }
}

/** The chat that most recently sent /start to the bot, or null. */
export async function findTelegramChat(net: Net, token: string): Promise<string | null> {
  const updates = (await tg(net, { telegramToken: token }, "getUpdates", { limit: 100 })) as Array<{ message?: { text?: string; chat?: { id: number } } }>;
  const hit = [...updates].reverse().find((u) => u.message?.text?.startsWith("/start") && u.message.chat);
  return hit ? String(hit.message!.chat!.id) : null;
}

export async function sendDiscord(net: Net, webhook: string, payload: object, file?: Attachment): Promise<void> {
  const s = { discordWebhook: webhook };
  const form = new FormData();
  form.set("payload_json", JSON.stringify(payload));
  if (file) form.set("files[0]", new Blob([file.body], { type: "text/html" }), file.name);
  let res: Response;
  try {
    res = await net(`${webhook}?wait=true`, { method: "POST", body: form });
  } catch (e) {
    throw new DeliveryError("discord", redact(`Discord did not answer: ${(e as Error).message}`, s), "check the internet connection; the send is retried");
  }
  if (res.ok) return;
  const j = (await res.json().catch(() => ({}))) as { message?: string };
  const hint =
    res.status === 404 ? "the webhook was deleted: create a new one and paste its URL"
    : res.status === 401 || res.status === 403 ? "the webhook URL is incomplete: copy it again"
    : res.status === 429 ? "Discord asks to slow down; the send is retried"
    : "Discord refused the message";
  throw new DeliveryError("discord", redact(`Discord: ${j.message ?? `HTTP ${res.status}`}`, s), hint);
}

/** Runs fn, waiting delaysMs[i] after the i-th failure; rethrows the last error. */
export async function withRetry<T>(fn: () => Promise<T>, o: { delaysMs: number[]; sleep: (ms: number) => Promise<void> }): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= o.delaysMs.length) throw e;
      await o.sleep(o.delaysMs[i]);
    }
  }
}

/** About 15 minutes of retries inside one run. */
export const RETRY_DELAYS_MS = [60_000, 240_000, 600_000];
