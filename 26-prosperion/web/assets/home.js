import { $, esc, walletEnv } from "./app.js";
import { mountShell, ICONS } from "./shell.js";

mountShell();
$("#send").innerHTML = ICONS.send;

// ---- the conversation lives in this tab: it survives a trip to the Vaults page, and "New Chat" starts over.
const SAVE = "ps_thread";
const history = (() => { try { return JSON.parse(sessionStorage.getItem(SAVE) || "[]"); } catch { return []; } })();
const keep = () => { try { sessionStorage.setItem(SAVE, JSON.stringify(history)); } catch {} };
const chatId = (() => {
  try { return localStorage.getItem("ps_chat") || (localStorage.setItem("ps_chat", crypto.randomUUID()), localStorage.getItem("ps_chat")); }
  catch { return crypto.randomUUID(); }
})();

$('[data-k="chat"]').addEventListener("click", (e) => {
  e.preventDefault();
  history.length = 0;
  keep();
  $("#chat").innerHTML = "";
  $("#chatmain").classList.remove("started");
  document.body.classList.remove("side-open");
  $("#ask-input").focus();
});

// The agent writes light markdown. Everything is escaped first, so only these few shapes become HTML,
// and links must be https.
// A bare link shows where it goes, not the whole URL: the agent links every address it cites.
const linkName = (url) => {
  try { const h = new URL(url.replace(/&amp;/g, "&")).hostname.replace(/^www\./, ""); return h === "pharosscan.xyz" ? "pharosscan" : h; }
  catch { return "link"; }
};
function md(src) {
  const inline = (s) => s
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https:\/\/[^\s<)]+)/g, (_m, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${linkName(url)}</a>`);
  let html = "", list = null, para = [];
  const flushPara = () => { if (para.length) { html += `<p>${inline(para.join("<br>"))}</p>`; para = []; } };
  const flushList = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const line of esc(src).split("\n")) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line), num = /^\s*\d+[.)]\s+(.*)$/.exec(line), head = /^#{1,4}\s+(.*)$/.exec(line);
    if (bullet || num) {
      flushPara();
      const want = bullet ? "ul" : "ol";
      if (list !== want) { flushList(); html += `<${want}>`; list = want; }
      html += `<li>${inline((bullet || num)[1])}</li>`;
    } else if (head) { flushPara(); flushList(); html += `<h3>${inline(head[1])}</h3>`; }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return html;
}

function bubble(cls, text) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  if (cls === "agent") d.innerHTML = md(text); else d.textContent = text;
  $("#chat").appendChild(d);
  $("#chat").scrollTop = $("#chat").scrollHeight;
  return d;
}

if (history.length) {
  $("#chatmain").classList.add("started");
  for (const m of history) bubble(m.role === "user" ? "you" : "agent", m.content);
}

// ---- composer: Enter sends, Shift+Enter is a new line, the box grows with the text
const input = $("#ask-input");
const fit = () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 240)}px`; $("#send").disabled = !input.value.trim(); };
input.addEventListener("input", fit);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); $("#ask-form").requestSubmit(); }
});
for (const c of document.querySelectorAll(".chip")) {
  c.addEventListener("click", () => { input.value = c.dataset.tip; fit(); $("#ask-form").requestSubmit(); });
}

let busy = false;
$("#ask-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  busy = true;
  input.value = ""; fit();
  $("#chatmain").classList.add("started");
  history.push({ role: "user", content: q });
  keep();
  bubble("you", q);
  const status = bubble("tool", "Reading the chain...");
  try {
    const env = await walletEnv();
    let address, chainId;
    try { address = env.providerObj ? (await env.providerObj.request({ method: "eth_accounts" }))[0] : undefined; } catch {}
    try { chainId = env.providerObj ? parseInt(await env.providerObj.request({ method: "eth_chainId" }), 16) : undefined; } catch {}
    const sendEnv = { provider: env.provider, rdns: env.rdns, inWalletBrowser: env.inWalletBrowser, desktopExtension: env.desktopExtension, chainId, address };
    const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history, env: sendEnv, chatId }) });
    if (!res.ok) {
      status.remove();
      bubble("error", (await res.json().catch(() => ({}))).error || `The agent did not answer (${res.status}). Try again in a moment.`);
      history.pop(); keep();
      return;
    }
    let out = null, text = "", buf = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(frame)?.[1];
        const data = /^data: (.+)$/m.exec(frame)?.[1];
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          // Hermes sends {tool, label, status: "running" | "completed"}; MCP tools arrive as mcp__<server>__<name>.
          if (event === "hermes.tool.progress") {
            if (j.status === "running") status.textContent = `Checking: ${String(j.tool || "a tool").replace(/^mcp__([a-z-]+)__/, "$1 ")}...`;
            continue;
          }
          const delta = j.choices?.[0]?.delta?.content;
          if (delta) {
            text += delta;
            if (!out) { out = bubble("agent", ""); $("#chat").insertBefore(out, status); }
            out.innerHTML = md(text);
            $("#chat").scrollTop = $("#chat").scrollHeight;
          }
        } catch {}
      }
    }
    status.remove();
    if (text) { history.push({ role: "assistant", content: text }); keep(); }
    else bubble("error", "The agent finished without an answer. Ask again.");
  } catch (e) {
    status.remove();
    bubble("error", `Lost the connection to the agent: ${e.message}`);
  } finally {
    busy = false;
    input.focus();
  }
});
