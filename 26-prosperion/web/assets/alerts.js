import { $, api, esc } from "./app.js";
import { mountShell, whoAmI, connectWallet } from "./shell.js";

mountShell();

// One sign-in for the whole site: if the wallet button already signed in, the watch form is open straight away.
async function openWatch(address) {
  $("#signin-status").textContent = `Signed in as ${address}.`;
  $("#watch-form").hidden = false;
  const w = await api("/watch").catch(() => null);
  if (w) { $("#per-buy").value = Number(BigInt(w.maxPerBuyWei)) / 1e18; $("#max-reserve").value = Number(BigInt(w.maxReserveBeforeWei)) / 1e18; }
}
whoAmI().then((me) => { if (me.address) openWatch(me.address); });
// Signing in or out from the wallet menu changes whose watch this is.
document.addEventListener("prosperion:me", (e) => {
  if (!$("#watch-form")) return; // a bot-less copy replaced the panel
  if (e.detail.address) return openWatch(e.detail.address);
  $("#watch-form").hidden = true;
  $("#signin-status").textContent = "";
  $("#watch-status").textContent = "";
});

$("#signin-btn").addEventListener("click", async () => {
  const st = $("#signin-status");
  try {
    st.textContent = "Check your wallet...";
    const me = await connectWallet();
    await openWatch(me.address);
  } catch (e) { st.textContent = e.message; }
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
    const link = `https://t.me/${bot}?start=${code}`;
    $("#watch-status").innerHTML = `Open <a href="${link}">${esc(link)}</a> and press Start. The code works once, for ten minutes.`;
  } catch (e) { $("#watch-status").textContent = e.message; }
});

// Alerts need a Telegram bot, and every copy of Prosperion brings its own (or none). Without one we say so
// instead of offering a sign-in that leads to a bot nobody runs.
const OWN_BOT_STEPS = "https://github.com/vi11abajo/Agentic-Economy/tree/main/26-prosperion#your-own-telegram-bot";
async function loadAlerts() {
  const { bot } = await api("/alerts").catch(() => ({ bot: null }));
  if (bot) return;
  $("#alerts-intro").innerHTML = `This copy runs without a Telegram bot, so it sends no alerts. New launches still show up on the <a href="/launches/">Launches</a> page with their checks, and the agent will look into any of them.`;
  $("#alert-panel").innerHTML = `<p>Alerts come from a bot you own: run Prosperion yourself, make a bot with <a href="https://t.me/BotFather">@BotFather</a> and give your copy its token. <a href="${OWN_BOT_STEPS}">The steps are in the README.</a></p>`;
}
loadAlerts();
