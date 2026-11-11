import { $, api, esc, pros, blockLink, addrLink, walletEnv, signIn, EXPLORER } from "./app.js";

// ---- launches
async function loadLaunches() {
  const box = $("#launch-list");
  try {
    const list = await api("/launches");
    if (!list.length) { box.innerHTML = `<p class="muted">No launch seen since the watcher started.</p>`; return; }
    box.innerHTML = list.map((l) => {
      const c = l.checks;
      const tag = !c ? `<span class="tag">not checked</span>`
        : !c.genuine ? `<span class="tag taken">not a Prosper market</span>`
        : c.phase !== 0 ? `<span class="tag">off the curve</span>`
        : BigInt(c.reserveBefore) === 0n ? `<span class="tag fresh">nobody in yet</span>` : `<span class="tag taken">${pros(c.reserveBefore)} PROS in</span>`;
      return `<div class="launch"><div>Market ${addrLink(l.market)}, token ${addrLink(l.pToken)}<br><span class="muted small">${blockLink(l.block)}, <a href="${EXPLORER}/tx/${l.tx}">creation tx</a></span></div><div>${tag}</div></div>`;
    }).join("");
  } catch (e) { box.innerHTML = `<p class="muted">Could not load launches: ${esc(e.message)}</p>`; }
}

// ---- vaults
async function loadVaults() {
  const body = $("#vault-list");
  try {
    const list = await api("/vaults");
    body.innerHTML = list.map((v) => `<tr><td><a href="/vault/?v=${v.r25Vault}">${esc(v.vaultName)}</a></td><td>${esc(v.pVaultSymbol)}</td><td class="muted">${esc(v.status)}</td></tr>`).join("");
  } catch (e) { body.innerHTML = `<tr><td colspan="3" class="muted">Could not load vaults: ${esc(e.message)}</td></tr>`; }
}

// ---- chat (history stays in this tab; the server adds what it knows about your wallet)
const history = [];
const chatId = (() => { try { return localStorage.getItem("ps_chat") || (localStorage.setItem("ps_chat", crypto.randomUUID()), localStorage.getItem("ps_chat")); } catch { return crypto.randomUUID(); } })();

function bubble(cls, text) {
  const d = document.createElement("div");
  d.className = `msg ${cls}`;
  d.textContent = text;
  $("#chat").appendChild(d);
  d.scrollIntoView({ block: "nearest" });
  return d;
}

$("#ask-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const q = $("#ask-input").value.trim();
  if (!q) return;
  $("#ask-input").value = "";
  history.push({ role: "user", content: q });
  bubble("you", q);
  const env = await walletEnv();
  let address;
  try { address = env.providerObj ? (await env.providerObj.request({ method: "eth_accounts" }))[0] : undefined; } catch {}
  let chainId;
  try { chainId = env.providerObj ? parseInt(await env.providerObj.request({ method: "eth_chainId" }), 16) : undefined; } catch {}
  const sendEnv = { provider: env.provider, rdns: env.rdns, inWalletBrowser: env.inWalletBrowser, desktopExtension: env.desktopExtension, chainId, address };
  const res = await fetch("/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ messages: history, env: sendEnv, chatId }) });
  if (!res.ok) { bubble("agent", (await res.json().catch(() => ({}))).error || `Error ${res.status}`); return; }
  const out = bubble("agent", "");
  const status = bubble("tool", "Reading the chain...");
  let text = "", buf = "";
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
        if (event === "hermes.tool.progress") { status.textContent = `Checking: ${j.tool_name || j.name || j.tool || "a tool"}...`; continue; }
        const delta = j.choices?.[0]?.delta?.content;
        if (delta) { text += delta; out.textContent = text; }
      } catch {}
    }
  }
  status.remove();
  history.push({ role: "assistant", content: text });
});

// ---- alerts
$("#signin-btn").addEventListener("click", async () => {
  const env = await walletEnv();
  const st = $("#signin-status");
  if (!env.providerObj) {
    st.textContent = env.mobile ? "Open this page inside your wallet app (OKX, Rabby or MetaMask) to sign in." : "No wallet found in this browser. Install a wallet extension, or open the page in your phone wallet.";
    return;
  }
  try {
    st.textContent = "Check your wallet...";
    const r = await signIn(env.providerObj);
    st.textContent = `Signed in as ${r.address}.`;
    $("#watch-form").hidden = false;
    const w = await api("/watch").catch(() => null);
    if (w) { $("#per-buy").value = Number(BigInt(w.maxPerBuyWei)) / 1e18; $("#max-reserve").value = Number(BigInt(w.maxReserveBeforeWei)) / 1e18; }
  } catch (e) { st.textContent = `Sign-in did not go through: ${e.message}`; }
});

const toWei = (x) => BigInt(Math.round(Number(x) * 1e6)) * 10n ** 12n;
$("#watch-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("/watch", { method: "POST", body: JSON.stringify({ maxPerBuyWei: toWei($("#per-buy").value).toString(), maxReserveBeforeWei: toWei($("#max-reserve").value).toString() }) });
    $("#watch-status").textContent = "Saved. Now link Telegram so the alerts have somewhere to go.";
  } catch (e) { $("#watch-status").textContent = e.message; }
});
$("#tg-btn").addEventListener("click", async () => {
  try {
    const { code, bot } = await api("/telegram/link", { method: "POST" });
    const link = bot ? `https://t.me/${bot}?start=${code}` : null;
    $("#watch-status").innerHTML = link
      ? `Open <a href="${link}">${esc(link)}</a> and press Start. The code works once, for ten minutes.`
      : `Send <code>/start ${code}</code> to the Prosperion bot. The code works once, for ten minutes.`;
  } catch (e) { $("#watch-status").textContent = e.message; }
});

loadLaunches();
loadVaults();
setInterval(loadLaunches, 30_000);
