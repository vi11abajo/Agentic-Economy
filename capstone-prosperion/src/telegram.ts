// Prosperion's Telegram bot, one for everyone who uses this copy. It only talks: alerts with buttons, a snipe as a QR
// of the signing link with buttons that open the page inside your wallet, the agent's notes as a reply, and a few
// commands. /start <code> ties a chat to the wallet that signed in on the site; nothing in Telegram can prove that.
// The token lives in the server's .env; the bot never sees a key or a seed and has nothing to sign with.
import QRCode from "qrcode";
import { getAddress, isAddress } from "viem";
import type { PushChannel, Wave1Extras } from "./alerts.js";
import { SITE, walletLinks } from "./links.js";
import type { OutMessage } from "./notifier.js";
import type { Button } from "./rules.js";
import type { Store } from "./store.js";
import { KINDS, type AlertBook, type Subs } from "./subscriptions.js";

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
    send: (m: OutMessage) => Promise<number>;
    answer: (callbackId: string, text: string) => Promise<void>;
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
    /** Any alert: HTML with buttons, or for a snipe the QR of the sign page with the wallet buttons on top. */
    async send(m: OutMessage): Promise<number> {
      const keyboard = (rows: Button[][]) => rows.map((row) => row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data })));
      if (m.sign) {
        const l = walletLinks(m.sign.url);
        const png = await QRCode.toBuffer(m.sign.url, { errorCorrectionLevel: "M", width: 512, margin: 2 });
        const form = new FormData();
        form.set("chat_id", String(m.chatId));
        form.set("caption", m.html.slice(0, 1024));
        form.set("parse_mode", "HTML");
        form.set("photo", new Blob([new Uint8Array(png)], { type: "image/png" }), "sign.png");
        form.set("reply_markup", JSON.stringify({ inline_keyboard: [
          [{ text: "Open in OKX", url: l.okx }, { text: "Open in Rabby", url: l.rabby }],
          [{ text: "Open in MetaMask", url: l.metamask }, { text: "Open the page", url: m.sign.url }],
          ...keyboard(m.buttons ?? []),
        ] }));
        return (await api("sendPhoto", form)).message_id as number;
      }
      const r = await api("sendMessage", {
        chat_id: m.chatId, text: m.html, parse_mode: "HTML", link_preview_options: { is_disabled: true },
        ...(m.replyTo ? { reply_parameters: { message_id: m.replyTo, allow_sending_without_reply: true } } : {}),
        ...(m.buttons?.length ? { reply_markup: { inline_keyboard: keyboard(m.buttons) } } : {}),
      });
      return r.message_id as number;
    },
    async answer(callbackId: string, text: string) {
      await api("answerCallbackQuery", { callback_query_id: callbackId, text });
    },
  };
  return channel;
}
export type TelegramChannel = ReturnType<typeof telegramChannel>;

export const BOT_COMMANDS = [
  { command: "status", description: "What this chat gets, and for which wallet" },
  { command: "settings", description: "Change what you get, on the site" },
  { command: "pause", description: "Quiet for a while: /pause 6h, /pause 2d" },
  { command: "resume", description: "End a pause" },
  { command: "follow", description: "Follow a market: /follow 0x..." },
  { command: "unfollow", description: "Stop following a market" },
  { command: "unlink", description: "Stop all alerts to this chat" },
];

// /status in words, one line per switched-on kind
const KIND_WORDS: { [K in keyof Subs]: (p: Subs[K]) => string } = {
  launch: (p) => `new launches${p.maxInCurvePros === null ? "" : ` with at most ${p.maxInCurvePros} PROS in the curve`}`,
  snipe: (p) => `snipe: a ready ${p.amountPros} PROS buy on launches with at most ${p.maxInCurvePros} PROS in`,
  progress: (p) => `progress at ${p.thresholds.join("/")}%${p.phase ? " and graduations" : ""} (${p.scope === "all" ? "every market" : "your markets"})`,
  positions: (p) => `your positions moving ${p.movePct}% (vault price ${p.navMovePct}%)`,
  whales: (p) => `trades of ${p.minPros}+ PROS (${p.scope === "all" ? "every market" : "your markets"})`,
  security: () => "your wallet on the gate: limits changed, buys",
  digest: (p) => `a daily digest at ${String(p.hourUtc).padStart(2, "0")}:00 UTC`,
};
const utc = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** One update from Telegram: a command typed in the chat, or a button pressed under an alert. */
export async function handleUpdate(u: any, store: Store, tg: TelegramChannel, book?: AlertBook): Promise<void> {
  const cb = u?.callback_query;
  if (cb && book) {
    const chatId: number | undefined = cb.message?.chat?.id;
    const [what, market] = String(cb.data ?? "").split(":");
    const mine = chatId ? book.addressesOfChat(chatId) : [];
    if (!mine.length || !market || !isAddress(market)) return tg.answer(cb.id, "This chat is not linked to a wallet any more.");
    for (const a of mine) {
      if (what === "follow") book.follow(a, market);
      if (what === "mute") book.mute(a, market, Date.now() + 30 * 86_400_000);
    }
    return tg.answer(cb.id, what === "follow" ? "Following: its progress and big trades count as yours now." : "Muted for 30 days.");
  }

  const chatId: number | undefined = u?.message?.chat?.id;
  const text: string = (u?.message?.text ?? "").trim();
  if (!chatId) return;
  const m = text.match(/^\/start\s+([0-9a-f]{12})$/);
  if (m) {
    const addr = store.linkTelegram(m[1], chatId);
    await tg.say(chatId, addr
      ? `Linked to ${addr}. Choose what you hear about on ${SITE}/alerts/ (launches, snipes, progress, positions, big trades, your gate, a daily digest). /status shows it here.`
      : "That code has expired or was already used. Get a fresh one on the site.");
    return;
  }
  if (text.startsWith("/start")) {
    await tg.say(chatId, `Hi. Sign in on ${SITE}/alerts/ with your wallet, pick your alerts, then press "Link Telegram" there.`);
    return;
  }
  if (!book || !text.startsWith("/")) return;
  const [cmd, arg = ""] = text.split(/\s+/, 2);
  const mine = book.addressesOfChat(chatId);
  if (!mine.length) return tg.say(chatId, `This chat is not linked to a wallet. Link it on ${SITE}/alerts/.`);

  switch (cmd.replace(/@.*$/, "")) {
    case "/status": {
      const lines = mine.flatMap((a) => {
        const subs = book.subsOf(a);
        const on = KINDS.filter((k) => subs[k].on).map((k) => `· ${(KIND_WORDS[k] as (p: unknown) => string)(subs[k])}`);
        const paused = book.pausedUntil(a);
        const follows = book.follows(a);
        return [`${a}${paused ? ` (paused until ${utc(paused)})` : ""}:`,
          ...(on.length ? on : ["· nothing switched on yet"]), ...(follows.length ? [`· following ${follows.length} market(s)`] : [])];
      });
      return tg.say(chatId, [...lines, "", `Change it: ${SITE}/alerts/`].join("\n"));
    }
    case "/settings": return tg.say(chatId, `${SITE}/alerts/`);
    case "/pause": {
      const p = /^(\d{1,3})\s*(h|d)$/i.exec(arg || "24h");
      if (!p) return tg.say(chatId, "Say how long: /pause 6h or /pause 2d (up to 30 days).");
      const ms = Math.min(Number(p[1]) * (p[2].toLowerCase() === "d" ? 86_400_000 : 3_600_000), 30 * 86_400_000);
      for (const a of mine) book.pause(a, Date.now() + ms);
      return tg.say(chatId, `Quiet until ${utc(Date.now() + ms)}. /resume ends it early.`);
    }
    case "/resume":
      for (const a of mine) book.pause(a, 0);
      return tg.say(chatId, "Alerts are back on.");
    case "/follow":
    case "/unfollow": {
      if (!isAddress(arg)) return tg.say(chatId, `Give the market address: ${cmd} 0x...`);
      for (const a of mine) (cmd === "/follow" ? book.follow(a, getAddress(arg)) : book.unfollow(a, getAddress(arg)));
      return tg.say(chatId, cmd === "/follow" ? "Following. Its progress and big trades count as your markets now." : "Not following it any more.");
    }
    case "/unlink":
      book.unlinkChat(chatId);
      return tg.say(chatId, "Unlinked. Nothing more comes here until you link again on the site.");
    default:
      return tg.say(chatId, BOT_COMMANDS.map((c) => `/${c.command}: ${c.description}`).join("\n"));
  }
}

/** Long-polls Telegram for commands and button presses. One poller per token: two would steal each other's updates. */
export async function pollTelegram(store: Store, tg: TelegramChannel, stop: () => boolean, book?: AlertBook) {
  let offset = 0;
  while (!stop()) {
    try {
      const updates = (await tg.api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] })) as any[];
      for (const u of updates) {
        offset = u.update_id + 1;
        await handleUpdate(u, store, tg, book).catch((e) => console.error(`[tg] ${e.message}`));
      }
    } catch (e) {
      console.error(`[tg] poll: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}
