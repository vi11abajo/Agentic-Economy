import { $, api, esc, pros, blockLink, addrLink, EXPLORER } from "./app.js";
import { mountShell, whoAmI, connectWallet } from "./shell.js";

mountShell();

// A launch still on the curve gets "Prepare first buy". It asks for an amount, signs the visitor in if needed, and
// sends them to the sign page, where the market is checked again and their own wallet does the rest.
// The tag shows what the watcher saw at creation; the server checks the market again before any link exists.
const canTry = (c) => c && c.genuine && c.phase === 0;
let openForm = null;

function row(l) {
  const c = l.checks;
  const tag = !c ? `<span class="tag">not checked</span>`
    : !c.genuine ? `<span class="tag taken">not a Prosper market</span>`
    : c.phase !== 0 ? `<span class="tag">off the curve</span>`
    : BigInt(c.reserveBefore) === 0n ? `<span class="tag fresh">nobody in yet</span>` : `<span class="tag taken">${pros(c.reserveBefore)} PROS in</span>`;
  const act = canTry(c)
    ? `<button type="button" class="quiet prep-open" data-market="${esc(l.market)}">Prepare first buy</button>`
    : "";
  return `<div class="launch" data-market="${esc(l.market)}">
    <div>Market ${addrLink(l.market)}, token ${addrLink(l.pToken)}<br><span class="muted small">${blockLink(l.block)}, <a href="${EXPLORER}/tx/${l.tx}">creation tx</a></span></div>
    <div class="launch-side">${tag}${act}</div>
    ${canTry(c) ? `<form class="prep" hidden>
      <label>PROS to spend<input name="amount" type="number" min="0.01" max="1000" step="0.01" value="1" required></label>
      <button type="submit">Continue to signing</button>
      <p class="small muted prep-note">Prosperion checks the market again and makes a link for your wallet. Nothing is sent from here.</p>
    </form>` : ""}
  </div>`;
}

async function loadLaunches() {
  // a half-filled form would vanish under the 30-second refresh
  if (openForm) return;
  const box = $("#launch-list");
  try {
    const list = await api("/launches");
    if (!list.length) { box.innerHTML = `<p class="muted">No launch seen since the watcher started. This page checks again every 30 seconds.</p>`; return; }
    box.innerHTML = list.map(row).join("");
  } catch (e) { box.innerHTML = `<p class="muted">Could not load launches: ${esc(e.message)}</p>`; }
}

$("#launch-list").addEventListener("click", (e) => {
  const b = e.target.closest(".prep-open");
  if (!b) return;
  const form = b.closest(".launch").querySelector(".prep");
  form.hidden = !form.hidden;
  openForm = form.hidden ? null : form;
  if (!form.hidden) form.amount.focus();
});

$("#launch-list").addEventListener("submit", async (e) => {
  const form = e.target.closest(".prep");
  if (!form) return;
  e.preventDefault();
  const note = form.querySelector(".prep-note"), go = form.querySelector("button[type=submit]");
  const market = form.closest(".launch").dataset.market;
  note.classList.remove("bad");
  go.disabled = true;
  try {
    let me = await whoAmI();
    if (!me.address) {
      note.textContent = "Check your wallet: it asks you to sign one sign-in message, not a transaction.";
      me = await connectWallet();
    }
    note.textContent = "Checking the market again...";
    const r = await api("/prepare", { method: "POST", body: JSON.stringify({ market, amountPros: String(form.amount.value) }) });
    location.href = r.url;
  } catch (err) {
    note.classList.add("bad");
    note.textContent = err.message;
    go.disabled = false;
  }
});

loadLaunches();
setInterval(loadLaunches, 30_000);
