// How the bookkeeper's news looks in Telegram (HTML) and Discord (an embed), and how it gets there. The delivery
// part comes from prosperDigest (task 13): both channels carry a secret in the URL, so every error goes through
// redact() before anyone can print it. A card counts as delivered when at least one configured channel took it.
import type { Card } from "./cards.js";
import { EXPLORER_TX } from "./chain.js";
import type { Notifier } from "./cards.js";
import type { Secrets } from "./store.js";

type Net = typeof fetch;

export function redact(text: string, s: Secrets): string {
  let out = text;
  const parts = [s.discordWebhook, s.discordWebhook?.split("/").pop(), s.telegramToken, s.telegramToken?.split(":").pop()].filter((x): x is string => !!x && x.length >= 6);
  for (const p of parts.sort((a, b) => b.length - a.length)) out = out.split(p).join("<hidden>");
  return out;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function localTime(iso: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("weekday")} ${g("day")} ${g("month")} ${g("year")}, ${g("hour")}:${g("minute")} (${tz})`;
}

const sum = (xs: string[]) => {
  // decimal strings, added without floats
  const d = Math.max(...xs.map((x) => (x.split(".")[1] ?? "").length));
  const total = xs.reduce((t, x) => t + BigInt(x.replace(".", "") + "0".repeat(d - (x.split(".")[1] ?? "").length)), 0n);
  const s = total.toString().padStart(d + 1, "0");
  return d ? `${s.slice(0, -d)}.${s.slice(-d)}`.replace(/\.?0+$/, "") : s;
};

/** One card as plain lines; link(text, url) decides the markup of each channel. */
function lines(c: Card, link: (text: string, url: string) => string, bold: (s: string) => string, txt: (s: string) => string): { title: string; body: string[] } {
  switch (c.kind) {
    case "paid":
      return {
        title: `✅ ${bold(txt(c.label))} · payment #${c.period + 1} paid`,
        body: [
          localTime(c.at, c.tz),
          ...c.lines.map((l) => `• ${txt(l.name)} — ${l.amount} ${c.token} to ${short(l.address)} · ${link(`tx ${short(l.tx)}`, EXPLORER_TX + l.tx)}`),
          ...(c.lines.length > 1 ? [`Total: ${sum(c.lines.map((l) => l.amount))} ${c.token}`] : []),
        ],
      };
    case "short":
      return {
        title: `⚠️ ${bold(txt(c.label))} · payment #${c.period + 1} to ${txt(c.name)} is waiting`,
        body: [`Due ${localTime(c.due, c.tz)}: ${c.amount} ${c.token}.`, `The wallet needs ${c.need} ${c.asset} and has ${c.have}.`, `Top up ${c.wallet} and I'll pay it on the next check, and only once.`],
      };
    case "missed":
      return {
        title: `⛔ ${bold(txt(c.label))} · payment #${c.period + 1} to ${txt(c.name)} was missed`,
        body: [`It was due ${localTime(c.due, c.tz)} (${c.amount} ${c.token}) and the period ended before it could be paid.`, `I won't pay it late on my own; ask me if you want it paid now.`],
      };
    case "failed":
      return {
        title: `❗ ${bold(txt(c.label))} · payment #${c.period + 1} to ${txt(c.name)} did not go through`,
        body: [`${c.amount} ${c.token}: ${txt(c.reason)}`, ...(c.tx ? [link(`tx ${short(c.tx)}`, EXPLORER_TX + c.tx)] : []), `I'll try again on the next check; it can still be paid only once.`],
      };
    case "runway":
      return {
        title: `💼 Wallet ${short(c.wallet)}: ${c.usdc} USDC, ${c.pros} PROS`,
        body: c.lines.map((l) =>
          l.nextShort
            ? `⚠️ ${txt(l.label)}: the next payment (${localTime(l.nextDue!, l.tz)}, ${l.perPeriod} ${l.token}) is not covered. Top up before then.`
            : `• ${txt(l.label)}: ${l.perPeriod} ${l.token} per period, enough for ${l.coversPeriods >= 52 ? "52+" : l.coversPeriods} more (until ${localTime(l.until!, l.tz)})`,
        ),
      };
    case "test":
      return { title: "🔔 bookkeeper is connected", body: [c.wallet ? `Paying wallet: ${c.wallet}` : "No paying wallet yet: run bookkeeper init."] };
  }
}

export function telegramHtml(c: Card): string {
  const l = lines(c, (t, u) => `<a href="${u}">${esc(t)}</a>`, (s) => `<b>${s}</b>`, esc);
  return [l.title, ...l.body].join("\n");
}

const COLORS: Record<Card["kind"], number> = { paid: 0x2e9e5b, short: 0xe0a100, missed: 0xc0392b, failed: 0xc0392b, runway: 0x3b6fd8, test: 0x888888 };

export function discordEmbed(c: Card): object {
  const l = lines(c, (t, u) => `[${t}](${u})`, (s) => s, (s) => s.replace(/([*_`~|\\])/g, "\\$1"));
  return { title: l.title.slice(0, 256), description: l.body.join("\n").slice(0, 4000), color: COLORS[c.kind] };
}

export function makeNotifier(s: Secrets, net: Net = fetch): Notifier {
  const channels = [s.telegramToken && s.telegramChatId ? "telegram" : null, s.discordWebhook ? "discord" : null].filter((x): x is string => !!x);
  return {
    channels,
    async send(card) {
      if (!channels.length) return;
      const errors: string[] = [];
      let ok = 0;
      if (channels.includes("telegram")) {
        try {
          const res = await net(`https://api.telegram.org/bot${s.telegramToken}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: s.telegramChatId, text: telegramHtml(card), parse_mode: "HTML", link_preview_options: { is_disabled: true } }) });
          const j = (await res.json().catch(() => ({}))) as { ok?: boolean; description?: string };
          if (res.ok && j.ok) ok++;
          else errors.push(`Telegram: ${j.description ?? `HTTP ${res.status}`}`);
        } catch (e) {
          errors.push(`Telegram did not answer: ${(e as Error).message}`);
        }
      }
      if (channels.includes("discord")) {
        try {
          const res = await net(`${s.discordWebhook}?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "bookkeeper", embeds: [discordEmbed(card)] }) });
          if (res.ok) ok++;
          else errors.push(`Discord: HTTP ${res.status}`);
        } catch (e) {
          errors.push(`Discord did not answer: ${(e as Error).message}`);
        }
      }
      if (!ok) throw new Error(redact(errors.join("; "), s));
    },
  };
}

/** The chat that most recently sent /start to the bot, or null (so the user never has to look up a chat id). */
export async function findTelegramChat(token: string, net: Net = fetch): Promise<string | null> {
  const res = await net(`https://api.telegram.org/bot${token}/getUpdates`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ limit: 100 }) });
  const j = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: Array<{ message?: { text?: string; chat?: { id: number } } }> };
  if (!j.ok) throw new Error(redact(`Telegram getUpdates: HTTP ${res.status}`, { telegramToken: token }));
  const hit = [...(j.result ?? [])].reverse().find((u) => u.message?.text?.startsWith("/start") && u.message.chat);
  return hit ? String(hit.message!.chat!.id) : null;
}
