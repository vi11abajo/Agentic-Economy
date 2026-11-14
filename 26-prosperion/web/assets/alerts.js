// The Alerts page: sign in, link Telegram to the shared Prosperion bot, and pick what it sends. The page only
// edits the signed-in wallet's own settings; the server checks every field again (subscriptions.ts parseSubs).
import { $, api, esc, addrLink } from "./app.js";
import { mountShell, whoAmI, connectWallet } from "./shell.js";

mountShell();
const form = $("#subs-form");
const field = (name) => form.elements.namedItem(name);
for (let h = 0; h < 24; h++) field("digest.hourUtc").insertAdjacentHTML("beforeend", `<option value="${h}">${String(h).padStart(2, "0")}:00</option>`);

function note(el, text, bad = false) {
  el.classList.toggle("bad", bad);
  el.innerHTML = text;
}

// ---- settings in and out of the form
function fill(s) {
  for (const k of ["launch", "snipe", "progress", "positions", "whales", "security", "digest"]) field(`${k}.on`).checked = !!s[k].on;
  field("launch.maxInCurvePros").value = s.launch.maxInCurvePros ?? "";
  field("launch.skipCurators").value = s.launch.skipCurators.join(", ");
  field("snipe.amountPros").value = s.snipe.amountPros;
  field("snipe.maxInCurvePros").value = s.snipe.maxInCurvePros;
  for (const t of [25, 50, 75, 90]) field(`progress.t${t}`).checked = s.progress.thresholds.includes(t);
  field("progress.phase").checked = s.progress.phase;
  field("progress.scope").value = s.progress.scope;
  field("positions.movePct").value = s.positions.movePct;
  field("positions.navMovePct").value = s.positions.navMovePct;
  field("whales.minPros").value = s.whales.minPros;
  field("whales.scope").value = s.whales.scope;
  field("digest.hourUtc").value = String(s.digest.hourUtc);
  markOn();
}
function read() {
  const v = (n) => field(n).value.trim();
  return {
    launch: { on: field("launch.on").checked, maxInCurvePros: v("launch.maxInCurvePros") || null, skipCurators: v("launch.skipCurators").split(/[\s,]+/).filter(Boolean) },
    snipe: { on: field("snipe.on").checked, amountPros: v("snipe.amountPros"), maxInCurvePros: v("snipe.maxInCurvePros") || "0" },
    progress: { on: field("progress.on").checked, thresholds: [25, 50, 75, 90].filter((t) => field(`progress.t${t}`).checked), phase: field("progress.phase").checked, scope: v("progress.scope") },
    positions: { on: field("positions.on").checked, movePct: Number(v("positions.movePct")), navMovePct: Number(v("positions.navMovePct")) },
    whales: { on: field("whales.on").checked, minPros: v("whales.minPros"), scope: v("whales.scope") },
    security: { on: field("security.on").checked },
    digest: { on: field("digest.on").checked, hourUtc: Number(v("digest.hourUtc")) },
  };
}
// a switched-off kind keeps its numbers but looks quiet
function markOn() {
  for (const p of form.querySelectorAll(".kind")) p.classList.toggle("off", !field(`${p.dataset.kind}.on`).checked);
}
form.addEventListener("change", markOn);
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const n = $("#subs-note");
  try {
    note(n, "Saving...");
    await api("/alerts/subs", { method: "POST", body: JSON.stringify(read()) });
    note(n, state.linked ? "Saved. The bot uses these from now on." : "Saved. Link Telegram above so the bot has somewhere to send them.");
  } catch (err) { note(n, esc(err.message), true); }
});

// ---- Telegram link, pause, follows
let state = { linked: false };
function drawTelegram(me, bot) {
  state = me;
  const paused = me.pausedUntil ? ` Paused until ${new Date(me.pausedUntil).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
  $("#tg-state").innerHTML = me.linked
    ? `Linked: <a href="https://t.me/${esc(bot)}">@${esc(bot)}</a> sends your alerts to your chat.${paused}`
    : `Not linked yet. Press the button, open the link in Telegram and press Start; the bot is <a href="https://t.me/${esc(bot)}">@${esc(bot)}</a>.`;
  $("#tg-actions").innerHTML = me.linked
    ? `${me.pausedUntil ? `<button type="button" id="tg-resume">Resume</button>` : `<button type="button" class="quiet" id="tg-pause">Pause for 24 h</button>`}
       <button type="button" class="quiet" id="tg-link">Link another chat</button> <button type="button" class="quiet" id="tg-unlink">Unlink</button>`
    : `<button type="button" id="tg-link">Link Telegram</button>`;
  $("#tg-link")?.addEventListener("click", linkTelegram);
  $("#tg-unlink")?.addEventListener("click", () => act("/telegram/unlink", {}, "Unlinked. The bot sends nothing until you link again."));
  $("#tg-pause")?.addEventListener("click", () => act("/alerts/pause", { hours: 24 }, "Paused for 24 hours."));
  $("#tg-resume")?.addEventListener("click", () => act("/alerts/pause", { hours: 0 }, "Alerts are back on."));
  const f = me.follows ?? [];
  $("#follows-panel").hidden = !f.length;
  $("#follows").innerHTML = f.map((m) => `<p class="row">${addrLink(m)} <button type="button" class="quiet" data-unfollow="${esc(m)}">Unfollow</button></p>`).join("");
}
$("#follows").addEventListener("click", (e) => {
  const m = e.target.closest("[data-unfollow]")?.dataset.unfollow;
  if (m) act("/alerts/unfollow", { market: m }, "Not following it any more.");
});
async function act(path, body, done) {
  try { await api(path, { method: "POST", body: JSON.stringify(body) }); await load(); note($("#tg-note"), done); }
  catch (e) { note($("#tg-note"), esc(e.message), true); }
}
async function linkTelegram() {
  try {
    const { code, bot } = await api("/telegram/link", { method: "POST" });
    const link = `https://t.me/${bot}?start=${code}`;
    note($("#tg-note"), `<a class="btn" href="${link}" target="_blank" rel="noopener">Open @${esc(bot)} and press Start</a> <span class="muted">The link works once, for ten minutes. Come back and reload when it says Linked.</span>`);
  } catch (e) { note($("#tg-note"), esc(e.message), true); }
}

// ---- who is here
async function load() {
  const r = await api("/alerts").catch(() => ({ bot: null }));
  if (!r.bot) {
    $("#alerts-intro").textContent = "This copy of Prosperion runs without a Telegram bot, so it sends no alerts. New launches still show on the Launches page with their checks.";
    for (const id of ["#who-panel", "#tg-panel", "#subs-form", "#follows-panel"]) $(id).hidden = true;
    return;
  }
  const signedIn = !!r.me;
  $("#who-panel").hidden = signedIn;
  $("#tg-panel").hidden = !signedIn;
  form.hidden = !signedIn;
  if (!signedIn) { $("#follows-panel").hidden = true; return; }
  drawTelegram(r.me, r.bot);
  fill(r.me.subs);
}
$("#signin-btn").addEventListener("click", async () => {
  const st = $("#signin-status");
  try { st.textContent = "Check your wallet..."; await connectWallet(); st.textContent = ""; await load(); }
  catch (e) { st.textContent = e.message; }
});
document.addEventListener("prosperion:me", () => load());
whoAmI().then(() => load());
