// Telegram bot (long polling, no webhook): subscriptions for whitelisted usernames, alerts on new trades.
import { config } from "./config.js";
import type { Db } from "./db.js";
import type { Indexer } from "./indexer.js";
import { EXPLORER, NATIVE, type TradeRow } from "./prosper.js";

interface TgUpdate {
  update_id: number;
  message?: { chat: { id: number }; from?: { username?: string }; text?: string };
}

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
  const send = (chatId: number, text: string) =>
    api("sendMessage", { chat_id: chatId, text, parse_mode: "HTML", disable_web_page_preview: true }).catch((e) =>
      console.error(`[telegram] send failed: ${e}`),
    );

  const allowed = (username?: string) => !!username && config.allowedUsernames.includes(username.toLowerCase());
  const help =
    "<b>Prosper curve alerts</b> — every buy and sell on Prosper bonding curves (Pharos).\n\n" +
    "/tokens — list tokens\n/watch &lt;token|all&gt; [min PROS] — alert me\n/unwatch &lt;token|all&gt;\n/list — my alerts\n\n" +
    `Live feed: ${config.publicUrl}`;

  const handle = async (chatId: number, username: string | undefined, text: string) => {
    const [cmdRaw, ...args] = text.trim().split(/\s+/);
    const cmd = cmdRaw.split("@")[0].toLowerCase();
    if (!allowed(username)) {
      await send(chatId,
        `Hi! Alerts are available by whitelist only.\nYour username: ${username ? "@" + username : "(not set — add one in Telegram settings)"}\n` +
        `Ask ${config.adminContact} to add you.\n\nThe public live feed is open to everyone: ${config.publicUrl}`);
      return;
    }
    if (cmd === "/start" || cmd === "/help") return send(chatId, help);
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

  (async () => {
    let offset = 0;
    console.log("[telegram] bot started");
    for (;;) {
      try {
        const r = await api("getUpdates", { offset, timeout: 30, allowed_updates: ["message"] });
        for (const u of (r.result as TgUpdate[] | undefined) ?? []) {
          offset = u.update_id + 1;
          if (u.message?.text) await handle(u.message.chat.id, u.message.from?.username, u.message.text);
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
  const who = `${t.trader.slice(0, 6)}…${t.trader.slice(-4)}`;
  const what = t.side === "BUY"
    ? `${who} paid <b>${fmt(t.pros)} ${NATIVE}</b> → received <b>${fmt(t.tokens)} ${t.symbol}</b>`
    : `${who} sold <b>${fmt(t.tokens)} ${t.symbol}</b> → received <b>${fmt(t.pros)} ${NATIVE}</b>`;
  return `${stamp} ${t.side === "BUY" ? "🟢 BUY" : "🔴 SELL"}
<b>${t.symbol}</b>
${what} <a href="${EXPLORER}/tx/${t.tx}">tx</a> - current price ${t.symbol} ${t.price.toPrecision(4)} ${NATIVE}`;
}

function fmt(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 6 });
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
