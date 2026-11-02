// The digest in four shapes: a Telegram message (HTML), a Discord webhook payload (embeds), a standalone HTML
// report (attached to both) and a Markdown copy for the archive.
import { EVENT_RULES } from "./events.js";
import { num, pct, short, unit } from "./format.js";
import { change } from "./metrics.js";
import { EXPLORER } from "./prosper.js";
import type { Digest, Metrics } from "./types.js";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const txUrl = (tx: string) => `${EXPLORER}/tx/${tx}`;
const day = (t: number) => new Date(t * 1000).toUTCString().slice(5, 11).trim();
const range = (d: Digest) => `${day(d.start)} - ${day(d.end - 86_400)} (UTC)`;

export const reportName = (d: Digest) => `prosper-digest-${d.key}`;

/** "▲ 23%" / "▼ 8%" / "n/a" */
function delta(cur: number, prev: number | undefined): string {
  const c = change(cur, prev);
  if (c === null) return "n/a";
  const r = Math.round(Math.abs(c));
  return r === 0 ? "= 0%" : `${c > 0 ? "▲" : "▼"} ${r}%`;
}

const ROWS: Array<[keyof Metrics, string, boolean]> = [
  ["volume", "Volume", true],
  ["netFlow", "Net into curves", true],
  ["trades", "Trades", false],
  ["traders", "Traders", false],
  ["fees", "Fees", true],
];

const val = (k: keyof Metrics, v: number, pros: boolean) => `${k === "netFlow" && v > 0 ? "+" : ""}${num(v)}${pros ? " PROS" : ""}`;

export function telegramText(d: Digest): string {
  const m = d.metrics, p = d.prev;
  const L: string[] = [];
  L.push(`<b>📊 Prosper Weekly · ${esc(d.label)}</b>`);
  L.push(`<i>${range(d)}${p ? ", vs the previous " + unit(d.days) : ", first digest"}</i>`, "");
  L.push("<b>Key numbers</b>");
  L.push(`Volume: <b>${val("volume", m.volume, true)}</b> ${delta(m.volume, p?.volume)}`);
  L.push(`   buys ${num(m.buys)} · sells ${num(m.sells)}`);
  L.push(`Net into curves: <b>${val("netFlow", m.netFlow, true)}</b> ${delta(m.netFlow, p?.netFlow)}`);
  L.push(`Trades: <b>${num(m.trades)}</b> ${delta(m.trades, p?.trades)}`);
  L.push(`Traders: <b>${num(m.traders)}</b> ${delta(m.traders, p?.traders)} · new ${num(m.newTraders)}`);
  L.push(`Fees: <b>${num(m.fees)} PROS</b> ${delta(m.fees, p?.fees)}`);
  L.push(`Markets: <b>+${m.newMarkets} new</b> · <b>${m.graduated} graduated</b> · ${m.onCurve} on curve`, "");
  L.push(d.events.length ? `<b>Top ${d.events.length} events</b>` : "<b>Top events</b>");
  if (!d.events.length) L.push("A quiet " + unit(d.days) + ": nothing stood out.");
  d.events.forEach((e, i) => L.push(`${i + 1}. ${icon(e.kind)} ${esc(e.title)}${e.tx ? ` · <a href="${txUrl(e.tx)}">tx</a>` : ""}`));
  if (d.trends.length) L.push("", "<b>Trends</b>", ...d.trends.map((t) => `• ${esc(t)}`));
  if (d.tokens.length) L.push("", "<b>Top tokens by volume</b>", d.tokens.slice(0, 3).map((t) => `$${esc(t.symbol)} ${num(t.volume)}`).join(" · "));
  L.push("", `<i>Read from Pharos mainnet at ${new Date(d.readAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC, blocks ${num(d.startBlock)} - ${num(d.endBlock)}</i>`);
  return L.join("\n");
}

const icon = (k: string) => ({ graduation: "🎓", big_trade: "🐋", mover: "🚀", new_market: "🆕", net_buyer: "💰" })[k] ?? "•";

export function discordPayload(d: Digest): object {
  const m = d.metrics, p = d.prev;
  const field = (name: string, value: string) => ({ name, value, inline: true });
  return {
    username: "Prosper Weekly",
    embeds: [
      {
        title: `📊 ${d.label} · ${range(d)}`,
        description: p ? `Compared with the previous ${unit(d.days)}.` : "First digest: nothing to compare with yet.",
        color: 0xf0b232,
        fields: [
          ...ROWS.map(([k, name, pros]) => field(name, `${val(k, m[k], pros)} ${delta(m[k], p?.[k])}`)),
          field("Markets", `+${m.newMarkets} new · ${m.graduated} grad · ${m.onCurve} on curve`),
        ],
      },
      {
        title: "Top events",
        color: 0x23a55a,
        description:
          (d.events.length ? d.events.map((e, i) => `${i + 1}. ${icon(e.kind)} ${e.title}${e.tx ? ` · [tx](${txUrl(e.tx)})` : ""}`).join("\n") : `A quiet ${unit(d.days)}: nothing stood out.`) +
          (d.trends.length ? `\n\n**Trends**\n${d.trends.map((t) => `• ${t}`).join("\n")}` : ""),
        footer: { text: `Pharos mainnet, blocks ${d.startBlock}-${d.endBlock}` },
      },
    ],
  };
}

export function htmlReport(d: Digest): string {
  const m = d.metrics, p = d.prev;
  const rows = ([...ROWS, ["buys", "Buys", true], ["sells", "Sells", true], ["newTraders", "New traders", false], ["newMarkets", "New markets", false], ["graduated", "Graduated", false], ["onCurve", "On curve", false]] as Array<[keyof Metrics, string, boolean]>)
    .map(([k, name, pros]) => `<tr><td>${name}</td><td>${val(k, m[k], pros)}</td><td>${p ? val(k, p[k], pros) : "n/a"}</td><td>${delta(m[k], p?.[k])}</td></tr>`)
    .join("");
  const tokens = d.tokens.map((t) => `<tr><td>$${esc(t.symbol)}</td><td>${num(t.volume)}</td><td>${t.trades}</td><td>${num(t.firstPrice)} → ${num(t.lastPrice)}</td><td>${pct(t.changePct)}</td><td>${phaseName(t.phaseEnd)}</td></tr>`).join("");
  const trades = d.topTrades.map((t) => `<tr><td>$${esc(t.symbol)}</td><td>${t.side}</td><td>${num(t.pros)} PROS</td><td>${short(t.trader)}</td><td><a href="${txUrl(t.tx)}">tx</a></td></tr>`).join("");
  const events = d.events.map((e) => `<li>${icon(e.kind)} ${esc(e.title)}${e.tx ? ` · <a href="${txUrl(e.tx)}">tx</a>` : ""}</li>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Prosper Digest ${esc(d.label)}</title>
<style>
:root{--bg:#fff;--fg:#1d2329;--mute:#66707a;--line:#e3e6ea;--accent:#c98a00}
@media (prefers-color-scheme:dark){:root{--bg:#111418;--fg:#e8ebee;--mute:#98a2ad;--line:#2a3038;--accent:#f0b232}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px 16px}
h1{margin:0}h2{margin-top:28px;border-bottom:1px solid var(--line);padding-bottom:4px}
.mute{color:var(--mute)}table{border-collapse:collapse;width:100%}td,th{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left}
a{color:var(--accent)}.wrap{overflow-x:auto}
</style></head><body>
<h1>📊 Prosper Digest · ${esc(d.label)}</h1>
<p class="mute">${range(d)}. Read from Pharos mainnet at ${new Date(d.readAt * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC, blocks ${d.startBlock} - ${d.endBlock}.</p>
<h2>Key numbers</h2>
<div class="wrap"><table><tr><th></th><th>This ${unit(d.days)}</th><th>Previous</th><th>Change</th></tr>${rows}</table></div>
<h2>Top events</h2>${events ? `<ol>${events}</ol>` : `<p>A quiet ${unit(d.days)}: nothing stood out.</p>`}
${d.trends.length ? `<h2>Trends</h2><ul>${d.trends.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>` : ""}
<h2>Tokens by volume</h2>
<div class="wrap"><table><tr><th>Token</th><th>Volume (PROS)</th><th>Trades</th><th>Price (PROS)</th><th>Change</th><th>Phase</th></tr>${tokens}</table></div>
<h2>Largest trades</h2>
<div class="wrap"><table><tr><th>Token</th><th>Side</th><th>Size</th><th>Trader</th><th></th></tr>${trades}</table></div>
<h2>New markets and graduations</h2>
<p>New: ${d.newMarkets.length ? d.newMarkets.map((s) => "$" + esc(s)).join(", ") : "none"}. Graduated: ${d.graduated.length ? d.graduated.map((s) => "$" + esc(s)).join(", ") : "none"}.</p>
<h2>How events were picked</h2>
<ul>${EVENT_RULES.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>
<p class="mute">The best 3 scores are shown, at most one per kind except graduations. Volume counts buys (PROS paid) and sells (PROS received); prices are PROS per token before fees, first to last trade of the ${unit(d.days)}.</p>
</body></html>
`;
}

const phaseName = (p: number | null) => (p === null ? "?" : ["on curve", "migrating", "graduated", "curve only"][p] ?? String(p));

export function markdownReport(d: Digest): string {
  const m = d.metrics, p = d.prev;
  const L = [`# Prosper Digest ${d.label}`, "", `${range(d)}, blocks ${d.startBlock}-${d.endBlock}`, "", "| Metric | This | Previous | Change |", "|---|---|---|---|"];
  for (const [k, name, pros] of ROWS) L.push(`| ${name} | ${val(k, m[k], pros)} | ${p ? val(k, p[k], pros) : "n/a"} | ${delta(m[k], p?.[k])} |`);
  L.push(`| Markets | +${m.newMarkets} new, ${m.graduated} graduated, ${m.onCurve} on curve | | |`, "", "## Top events", "");
  d.events.forEach((e, i) => L.push(`${i + 1}. ${e.title}${e.tx ? ` ([tx](${txUrl(e.tx)}))` : ""}`));
  if (d.trends.length) L.push("", "## Trends", "", ...d.trends.map((t) => `- ${t}`));
  L.push("", "## Tokens by volume", "", "| Token | Volume | Trades | Change |", "|---|---|---|---|", ...d.tokens.map((t) => `| $${t.symbol} | ${num(t.volume)} | ${t.trades} | ${pct(t.changePct)} |`));
  return L.join("\n") + "\n";
}
