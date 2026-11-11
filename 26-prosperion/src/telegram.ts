// Prosperion's Telegram bot. It only talks: a launch photo (QR of the signing link) with buttons that open the page
// inside your wallet, the agent's reply under it, and /start <code> to tie a chat to the address you signed in with.
// The token lives in the server's .env; the bot never sees a key or a seed and has nothing to sign with.
import QRCode from "qrcode";
import type { PushChannel, Wave1Extras } from "./alerts.js";
import type { Store } from "./store.js";

type Fetch = typeof fetch;

export function telegramChannel(token: string, f: Fetch = fetch) {
  const api = async (method: string, body: unknown) => {
    const isForm = body instanceof FormData;
    const res = await f(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: isForm ? undefined : { "content-type": "application/json" },
      body: isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    const j = (await res.json()) as { ok: boolean; result?: any; description?: string };
    if (!j.ok) throw new Error(`telegram ${method}: ${j.description}`);
    return j.result;
  };

  const channel: PushChannel & {
    say: (chatId: number, text: string) => Promise<void>;
    api: typeof api;
  } = {
    api,
    async sendWave1(chatId: number, text: string, extras?: Wave1Extras) {
      if (!extras) {
        const m = await api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
        return m.message_id as number;
      }
      const png = await QRCode.toBuffer(extras.url, { errorCorrectionLevel: "M", width: 512, margin: 2 });
      const form = new FormData();
      form.set("chat_id", String(chatId));
      form.set("caption", text.slice(0, 1024));
      form.set("parse_mode", "HTML");
      form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "sign.png");
      form.set("reply_markup", JSON.stringify({
        inline_keyboard: [
          [{ text: "Open in OKX", url: extras.links.okx }, { text: "Open in Rabby", url: extras.links.rabby }],
          [{ text: "Open in MetaMask", url: extras.links.metamask }, { text: "Open the page", url: extras.url }],
        ],
      }));
      const m = await api("sendPhoto", form);
      return m.message_id as number;
    },
    async sendWave2(chatId: number, replyTo: number, text: string) {
      await api("sendMessage", { chat_id: chatId, text, reply_parameters: { message_id: replyTo, allow_sending_without_reply: true }, link_preview_options: { is_disabled: true } });
    },
    async say(chatId: number, text: string) {
      await api("sendMessage", { chat_id: chatId, text, link_preview_options: { is_disabled: true } });
    },
  };
  return channel;
}
export type TelegramChannel = ReturnType<typeof telegramChannel>;

export async function handleUpdate(u: any, store: Store, tg: TelegramChannel): Promise<void> {
  const chatId: number | undefined = u?.message?.chat?.id;
  const text: string = u?.message?.text ?? "";
  if (!chatId) return;
  const m = text.match(/^\/start\s+([0-9a-f]{12})$/);
  if (m) {
    const addr = store.linkTelegram(m[1], chatId);
    await tg.say(chatId, addr
      ? `Linked. Launch alerts for ${addr} will come here. Change limits or unlink on the site.`
      : "That code has expired or was already used. Get a fresh one on the site.");
    return;
  }
  if (text.startsWith("/start")) {
    await tg.say(chatId, "Hi. Sign in on prosperion.pharosfdv.xyz, set your watch, then tap \"Link Telegram\" there.");
  }
}

/** Long-polls Telegram for /start messages. One poller per token: prosper-monitor's bot needs its own token. */
export async function pollTelegram(store: Store, tg: TelegramChannel, stop: () => boolean) {
  let offset = 0;
  while (!stop()) {
    try {
      const updates = (await tg.api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] })) as any[];
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u, store, tg).catch((e) => console.error(`[tg] ${e.message}`));
      }
    } catch (e) {
      console.error(`[tg] poll: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
