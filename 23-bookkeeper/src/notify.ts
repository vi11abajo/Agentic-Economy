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

/** Amounts for people: at most 6 decimals, no trailing zeros (0.008893598579752846 -> 0.008894). */
export const pretty = (x: string, max = 6) => {
  const n = Number(x);
  return Number.isFinite(n) ? String(+n.toFixed(max)) : x;
};

const link = {
  tg: (t: string, u: string) => `<a href="${u}">${esc(t)}</a>`,
  dc: (t: string, u: string) => `[${t}](${u})`,
};
const dcText = (s: string) => s.replace(/([*_`~|\\])/g, "\\$1");

export function telegramHtml(c: Card): string {
  const b = (s: string) => `<b>${esc(s)}</b>`;
  switch (c.kind) {
    case "paid":
      return [
        `✅ ${b(c.label)}`,
        `Payment #${c.period + 1} paid · ${localTime(c.at, c.tz)}`,
        "",
        ...c.lines.flatMap((l) => [`👤 ${b(l.name)} — ${l.amount} ${c.token}`, `     <code>${short(l.address)}</code> · ${link.tg(`tx ${short(l.tx)}`, EXPLORER_TX + l.tx)}`]),
        "",
        ...(c.lines.length > 1 ? [`${b("Total:")} ${sum(c.lines.map((l) => l.amount))} ${c.token}`] : []),
        ...(c.next ? [`⏭ Next payment: ${localTime(c.next, c.tz)}`] : []),
      ].join("\n");
    case "short":
      return [
        `⚠️ ${b(c.label)}`,
        `Payment #${c.period + 1} to ${b(c.name)} is waiting for money`,
        "",
        `Due: ${localTime(c.due, c.tz)} · ${c.amount} ${c.token}`,
        `The wallet needs ${pretty(c.need)} ${esc(c.asset)} and has ${pretty(c.have)}.`,
        "",
        `Top up <code>${c.wallet}</code> and I'll pay it on the next check, and only once.`,
      ].join("\n");
    case "missed":
      return [`⛔ ${b(c.label)}`, `Payment #${c.period + 1} to ${b(c.name)} was missed`, "", `It was due ${localTime(c.due, c.tz)} (${c.amount} ${c.token}) and the period ended before it could be paid.`, `I won't pay it late on my own; ask me if you want it paid now.`].join("\n");
    case "failed":
      return [`❗ ${b(c.label)}`, `Payment #${c.period + 1} to ${b(c.name)} did not go through`, "", `${c.amount} ${c.token}: ${esc(c.reason)}`, ...(c.tx ? [link.tg(`tx ${short(c.tx)}`, EXPLORER_TX + c.tx)] : []), `I'll try again on the next check; it can still be paid only once.`].join("\n");
    case "runway":
      return [
        `💼 ${b("Wallet")} <code>${short(c.wallet)}</code>`,
        `${pretty(c.usdc)} USDC · ${pretty(c.pros)} PROS`,
        "",
        ...c.lines.map((l) =>
          l.nextShort
            ? `⚠️ ${b(l.label)}: the next payment (${localTime(l.nextDue!, l.tz)}, ${l.perPeriod} ${l.token}) is not covered. Top up before then.`
            : `📆 ${b(l.label)}: ${l.perPeriod} ${l.token} per period, enough for ${l.coversPeriods >= 52 ? "52+" : l.coversPeriods} more (until ${localTime(l.until!, l.tz)})`,
        ),
      ].join("\n");
    case "test":
      return [`🔔 ${b("bookkeeper is connected")}`, c.wallet ? `Paying wallet: <code>${c.wallet}</code>` : "No paying wallet yet: fill BOOKKEEPER_PRIVATE_KEY."].join("\n");
  }
}

const COLORS: Record<Card["kind"], number> = { paid: 0x2e9e5b, short: 0xe0a100, missed: 0xc0392b, failed: 0xc0392b, runway: 0x3b6fd8, test: 0x888888 };
const FOOT = "bookkeeper · Pharos mainnet";

export function discordEmbed(c: Card): object {
  const base = { color: COLORS[c.kind] };
  const foot = (extra?: string) => ({ footer: { text: extra ? `${FOOT} · ${extra}` : FOOT } });
  switch (c.kind) {
    case "paid":
      return {
        ...base,
        title: `✅ ${c.label} · payment #${c.period + 1} paid`.slice(0, 256),
        description: `🗓 ${localTime(c.at, c.tz)}${c.lines.length > 1 ? `\nTotal **${sum(c.lines.map((l) => l.amount))} ${c.token}** to ${c.lines.length} people` : ""}`,
        fields: c.lines.slice(0, 25).map((l) => ({ name: l.name.slice(0, 256), value: `**${l.amount} ${c.token}**\n\`${short(l.address)}\`\n${link.dc(`tx ${short(l.tx)}`, EXPLORER_TX + l.tx)}`, inline: true })),
        ...foot(c.next ? `Next payment: ${localTime(c.next, c.tz)}` : undefined),
        timestamp: c.at,
      };
    case "short":
      return {
        ...base,
        title: `⚠️ ${c.label} · payment #${c.period + 1} to ${c.name} is waiting`.slice(0, 256),
        description: `Due ${localTime(c.due, c.tz)}: **${c.amount} ${c.token}**. I'll pay it on the next check after a top-up, and only once.`,
        fields: [
          { name: "Needs", value: `${pretty(c.need)} ${c.asset}`, inline: true },
          { name: "Has", value: `${pretty(c.have)} ${c.asset}`, inline: true },
          { name: "Top up", value: `\`${c.wallet}\``, inline: false },
        ],
        ...foot(),
      };
    case "missed":
      return { ...base, title: `⛔ ${c.label} · payment #${c.period + 1} to ${c.name} was missed`.slice(0, 256), description: `It was due ${localTime(c.due, c.tz)} (**${c.amount} ${c.token}**) and the period ended before it could be paid.\nI won't pay it late on my own; ask me if you want it paid now.`, ...foot() };
    case "failed":
      return { ...base, title: `❗ ${c.label} · payment #${c.period + 1} to ${c.name} did not go through`.slice(0, 256), description: `**${c.amount} ${c.token}**: ${dcText(c.reason)}${c.tx ? `\n${link.dc(`tx ${short(c.tx)}`, EXPLORER_TX + c.tx)}` : ""}\nI'll try again on the next check; it can still be paid only once.`.slice(0, 4000), ...foot() };
    case "runway":
      return {
        ...base,
        title: `💼 Wallet ${short(c.wallet)}`,
        fields: [
          { name: "USDC", value: pretty(c.usdc), inline: true },
          { name: "PROS (gas)", value: pretty(c.pros), inline: true },
          ...c.lines.slice(0, 20).map((l) => ({
            name: dcText(l.label).slice(0, 256),
            value: l.nextShort ? `⚠️ The next payment (${localTime(l.nextDue!, l.tz)}, **${l.perPeriod} ${l.token}**) is not covered. Top up before then.` : `📆 ${l.perPeriod} ${l.token} per period · enough for **${l.coversPeriods >= 52 ? "52+" : l.coversPeriods} more** (until ${localTime(l.until!, l.tz)})`,
            inline: false,
          })),
        ],
        ...foot(),
      };
    case "test":
      return { ...base, title: "🔔 bookkeeper is connected", description: c.wallet ? `Paying wallet: \`${c.wallet}\`` : "No paying wallet yet: fill BOOKKEEPER_PRIVATE_KEY.", ...foot() };
  }
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
