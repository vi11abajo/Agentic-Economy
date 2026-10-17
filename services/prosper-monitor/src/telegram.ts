// Telegram bot (long polling, no webhook): subscriptions for whitelisted usernames, alerts on new trades.
import { config } from "./config.js";
import type { Db } from "./db.js";
import type { Indexer } from "./indexer.js";
import { EXPLORER, NATIVE, type TradeRow } from "./prosper.js";

interface TgUser { id: number; username?: string; first_name?: string; last_name?: string }
interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; from?: TgUser; text?: string };
  callback_query?: { id: string; from: TgUser; data?: string; message?: { chat: { id: number }; message_id: number; text?: string } };
}
type Markup = { inline_keyboard: { text: string; callback_data: string }[][] };

export function startTelegram(db: Db, indexer: Indexer): void {
  if (!config.telegramToken) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled");
    return;
  }
  const api = (method: string, body: Record<string, unknown>) =>
    fetch(`https://api.telegram.org/bot${config.telegramToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<{ ok: boolean; result?: unknown; description?: string }>);
  const send = (chatId: number, text: string, markup?: Markup) =>
    api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true, reply_markup: markup }).catch((e) =>
      console.error(`[telegram] send failed: ${e}`),
    );

  // Whitelist = usernames from .env + usernames the admin approved in the bot (kept in the database).
  const adminName = config.adminContact.replace(/^@/, "").toLowerCase();
  const isAdmin = (username?: string) => !!username && username.toLowerCase() === adminName;
  const granted = (): string[] => JSON.parse(db.meta("tg_granted") ?? "[]");
  const setGranted = (list: string[]) => db.setMeta("tg_granted", JSON.stringify([...new Set(list)].sort()));
  const allowed = (username?: string) => {
    const u = username?.toLowerCase();
    return !!u && (u === adminName || config.allowedUsernames.includes(u) || granted().includes(u));
  };
  const adminChat = () => Number(db.meta("tg_admin_chat") ?? 0) || undefined;
  const pending = new Map<string, number>(); // username -> time of the last request (anti-spam)
  const REQUEST_COOLDOWN_MS = 6 * 3600_000;
  const requestButton: Markup = { inline_keyboard: [[{ text: "🔑 Request access", callback_data: "req" }]] };

  const requestAccess = async (chatId: number, from: TgUser) => {
    const u = from.username?.toLowerCase();
    if (!u) return send(chatId, "Set a Telegram username first (Settings → Username), then press the button again.", requestButton);
    if (allowed(u)) return send(chatId, "You already have access. /help");
    const admin = adminChat();
    if (!admin) {
      console.error(`[telegram] access request from @${u}, but the admin has not started the bot yet`);
      return send(chatId, `The admin is not reachable through the bot yet. Please write to ${config.adminContact} directly.`);
    }
    const last = pending.get(u);
    if (last && Date.now() - last < REQUEST_COOLDOWN_MS) return send(chatId, "Your request is already with the admin — you will get a message here once it is reviewed.");
    pending.set(u, Date.now());
    const name = esc([from.first_name, from.last_name].filter(Boolean).join(" ") || "—");
    await send(admin, `🔑 <b>Access request</b>\n@${esc(u)} · ${name} · id ${from.id}`, {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `ok:${chatId}:${u}` },
        { text: "❌ Deny", callback_data: `no:${chatId}:${u}` },
      ]],
    });
    return send(chatId, "✉️ Request sent to the admin. You will get a message here once it is reviewed.");
  };

  const onCallback = async (q: NonNullable<TgUpdate["callback_query"]>) => {
    const answer = (text?: string) => api("answerCallbackQuery", { callback_query_id: q.id, text }).catch(() => {});
    const chatId = q.message?.chat.id ?? q.from.id;
    if (q.data === "req") {
      await answer();
      return requestAccess(chatId, q.from);
    }
    const m = /^(ok|no):(-?\d+):([a-z0-9_]{1,64})$/.exec(q.data ?? "");
    if (!m) return answer();
    // Only the admin can decide; the buttons are only ever sent to the admin's chat, but check anyway.
    if (!isAdmin(q.from.username)) return answer("Admin only");
    const [, verdict, userChat, u] = m;
    pending.delete(u);
    if (verdict === "ok") {
      setGranted([...granted(), u]);
      await send(Number(userChat), "✅ Access granted! Try /watch pMusk or /help");
    } else {
      await send(Number(userChat), `❌ Access request declined. Questions: ${config.adminContact}`);
    }
    await answer(verdict === "ok" ? "Approved" : "Denied");
    if (q.message) {
      await api("editMessageText", {
        chat_id: q.message.chat.id, message_id: q.message.message_id, parse_mode: "HTML",
        text: `${esc(q.message.text ?? "Access request")}\n\n${verdict === "ok" ? "✅ approved" : "❌ denied"}`,
      }).catch(() => {});
    }
  };
  const help =
    "<b>Prosper curve alerts</b> — every buy and sell on Prosper bonding curves (Pharos).\n\n" +
    "/tokens — list tokens\n/watch &lt;token|all&gt; [min PROS] — alert me\n/unwatch &lt;token|all&gt;\n/list — my alerts\n\n" +
    `Live feed: ${config.publicUrl}`;
  const adminHelp =
    "\n\n<b>Admin</b>\n/users — whitelist\n/grant @user — add\n/revoke @user — remove and stop alerts\n" +
    "Access requests arrive here with Approve / Deny buttons.";

  const handle = async (chatId: number, from: TgUser | undefined, text: string) => {
    const username = from?.username;
    const [cmdRaw, ...args] = text.trim().split(/\s+/);
    const cmd = cmdRaw.split("@")[0].toLowerCase();
    if (isAdmin(username) && db.meta("tg_admin_chat") !== String(chatId)) db.setMeta("tg_admin_chat", String(chatId));
    if (!allowed(username)) {
      if (cmd === "/request" && from) return requestAccess(chatId, from);
      await send(chatId,
        `Hi! Alerts are available by whitelist only.\nYour username: ${username ? "@" + esc(username) : "(not set — add one in Telegram settings)"}\n\n` +
        `Press the button to ask the admin for access.\n\nThe public live feed is open to everyone: ${config.publicUrl}`,
        requestButton);
      return;
    }
    if (cmd === "/start" || cmd === "/help") return send(chatId, isAdmin(username) ? help + adminHelp : help);
    if (isAdmin(username) && cmd === "/users") {
      const env = config.allowedUsernames, extra = granted().filter((u) => !env.includes(u));
      return send(chatId, `<b>Whitelist</b>\nfrom .env: ${env.map((u) => "@" + u).join(", ") || "—"}\napproved in bot: ${extra.map((u) => "@" + u).join(", ") || "—"}`);
    }
    if (isAdmin(username) && (cmd === "/grant" || cmd === "/revoke")) {
      const u = args[0]?.replace(/^@/, "").toLowerCase();
      if (!u || !/^[a-z0-9_]{1,64}$/.test(u)) return send(chatId, `Usage: ${cmd} @username`);
      if (cmd === "/grant") {
        setGranted([...granted(), u]);
        return send(chatId, `✅ @${u} added.`);
      }
      setGranted(granted().filter((x) => x !== u));
      for (const s of db.subsByUsername(u)) db.delAllSubs(s.chatId);
      return send(chatId, config.allowedUsernames.includes(u)
        ? `@${u} removed from the bot list, but is still in TELEGRAM_ALLOWED_USERNAMES (.env).`
        : `🚫 @${u} removed, alerts stopped.`);
    }
    if (cmd === "/tokens") {
      const list = indexer.allMarkets().map((m) => `<b>${m.symbol}</b> ${esc(m.name)} · …${m.vault.slice(-6).toLowerCase()}`);
      return send(chatId, list.length ? list.join("\n") : "No markets indexed yet.");
    }
    if (cmd === "/watch" || cmd === "/unwatch") {
      const target = args[0];
      if (!target) return send(chatId, `Usage: ${cmd} &lt;token|all&gt;${cmd === "/watch" ? " [min PROS]" : ""}`);
      const market = target.toLowerCase() === "all" ? "*" : findMarket(indexer, target);
      if (!market) return send(chatId, `Unknown token "${esc(target)}". See /tokens`);
      if (cmd === "/unwatch") {
        if (market === "*") db.delAllSubs(chatId);
        else db.delSub(chatId, market);
        return send(chatId, "Removed.");
      }
      const min = Number(args[1] ?? 0) || 0;
      db.addSub(chatId, username!, market, min);
      const label = market === "*" ? "all tokens" : indexer.market(market)?.symbol;
      return send(chatId, `✅ Watching <b>${label}</b>${min ? ` · trades ≥ ${min} ${NATIVE}` : ""}`);
    }
    if (cmd === "/list") {
      const subs = db.subsByChat(chatId);
      return send(chatId, subs.length
        ? subs.map((s) => `• ${s.market === "*" ? "all tokens" : indexer.market(s.market)?.symbol ?? s.market}${s.minPros ? ` ≥ ${s.minPros} ${NATIVE}` : ""}`).join("\n")
        : "No alerts yet. /watch &lt;token&gt;");
    }
    return send(chatId, help);
  };

  indexer.on("phase", (m: { symbol: string; market: string; label: string }) => {
    const notified = new Set<number>();
    for (const s of db.subsByMarket(m.market)) {
      if (s.market !== m.market || notified.has(s.chatId)) continue;
      notified.add(s.chatId);
      void send(s.chatId, `ℹ️ <b>${m.symbol}</b> is ${m.label} — it left the bonding curve and is no longer monitored.`);
      db.delSub(s.chatId, m.market);
    }
  });

  indexer.on("trade", (t: TradeRow) => {
    for (const s of db.subsByMarket(t.market)) {
      if (!allowed(s.username) || t.pros < (s.minPros || 0)) continue;
      void send(s.chatId, formatTrade(t));
    }
  });

  // Bot profile: command menu and the texts shown before /start.
  void Promise.all([
    api("setMyCommands", {
      commands: [
        { command: "watch", description: "Alert me: /watch <token|all> [min PROS]" },
        { command: "unwatch", description: "Stop alerts: /unwatch <token|all>" },
        { command: "list", description: "My alerts" },
        { command: "tokens", description: "Tokens on the bonding curve" },
        { command: "help", description: "How it works" },
        { command: "request", description: "Ask the admin for access" },
      ],
    }),
    api("setMyShortDescription", {
      short_description: "Live alerts for every buy and sell on Prosper bonding curves (Pharos). Feed: " + config.publicUrl,
    }),
    api("setMyDescription", {
      description:
        "Alerts for every buy and sell of Prosper tokens that are still on the bonding curve (Pharos mainnet), " +
        "indexed live through Pharos Chain MCP.\n\nAccess by whitelist — ask " + config.adminContact + ".\n" +
        "Public live feed: " + config.publicUrl,
    }),
  ]).then((r) => r.forEach((x) => !x.ok && console.error(`[telegram] profile: ${x.description}`)))
    .catch((e) => console.error(`[telegram] profile: ${e}`));

  (async () => {
    let offset = 0;
    console.log("[telegram] bot started");
    for (;;) {
      try {
        const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message", "callback_query"] });
        for (const u of (r.result as TgUpdate[] | undefined) ?? []) {
          offset = u.update_id + 1;
          if (u.message?.text) await handle(u.message.chat.id, u.message.from, u.message.text);
          else if (u.callback_query) await onCallback(u.callback_query);
        }
      } catch (e) {
        console.error(`[telegram] ${e}`);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  })();
}

function findMarket(indexer: Indexer, q: string): string | undefined {
  const t = q.toLowerCase().replace(/^.*-(?=[0-9a-f]{6}$)/, "");
  const m = indexer.allMarkets().find((x) =>
    x.symbol.toLowerCase() === t || x.market === t || x.pToken.toLowerCase() === t || x.vault.toLowerCase().endsWith(t));
  return m?.market;
}

export function formatTrade(t: TradeRow): string {
  const d = new Date(t.time * 1000);
  const z = (n: number) => String(n).padStart(2, "0");
  // Telegram has no viewer time zone: dates are UTC.
  const stamp = `${z(d.getUTCDate())}.${z(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} - ${z(d.getUTCHours())}.${z(d.getUTCMinutes())}.${z(d.getUTCSeconds())} UTC`;
  const who = `<a href="${EXPLORER}/address/${t.trader}">${t.trader.slice(0, 6)}…${t.trader.slice(-4)}</a>`;
  const sym = esc(t.symbol);
  const buy = t.side === "BUY";
  const flow = buy
    ? `<b>${fmt(t.pros)} ${NATIVE}</b> → <b>${fmt(t.tokens)} ${sym}</b>`
    : `<b>${fmt(t.tokens)} ${sym}</b> → <b>${fmt(t.pros)} ${NATIVE}</b>`;
  return [
    `${buy ? "🟢" : "🔴"} <b>${t.side} · ${sym}</b>`,
    "",
    `${buy ? "💰 Paid" : "💸 Sold"}  ${flow}`,
    `👤 Trader  ${who}`,
    `📈 Price  <code>${t.price.toPrecision(4)}</code> ${NATIVE} per ${sym}`,
    `🧱 Block  ${t.block.toLocaleString("en-US")}`,
    "",
    `🕒 ${stamp}  ·  <a href="${EXPLORER}/tx/${t.tx}">View tx ↗</a>`,
  ].join("\n");
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 6 });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
