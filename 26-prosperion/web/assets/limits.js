// "Your buy limits" on the Launches page: what the gate holds for the signed-in wallet, a form to change it, and a
// Stop button that clears it. The server only reads the gate and encodes setLimits; the visitor's wallet signs.
import { $, api, esc, pros, short, addrLink, walletEnv, connect, ensurePharos, EXPLORER } from "./app.js";
import { sendOne } from "./wallet.js";
import { whoAmI, connectWallet } from "./shell.js";

const box = $("#limits");
// inputs want plain numbers; pros() adds thousands separators
const plain = (raw) => String(Number(BigInt(raw)) / 1e18);

function say(text, bad = false) {
  const n = $("#limits-note");
  n.classList.toggle("bad", bad);
  n.innerHTML = text;
}

function signedOutView() {
  box.innerHTML = `<h2>Your buy limits</h2>
    <p>The gate lets a buy through only within limits your own wallet set: per buy, per day, and how much may already be in the curve. Connect to see yours.</p>
    <div class="row"><button type="button" class="quiet" id="limits-connect">Connect wallet</button></div>
    <p class="small" id="limits-note"></p>`;
  $("#limits-connect").addEventListener("click", async () => {
    try { await connectWallet(); } catch (e) { say(esc(e.message), true); }
  });
}

function summary(s) {
  const l = s.limits;
  if (!l) return `<p>No limits set for ${addrLink(s.address)}, so the gate refuses every buy from it. Set them here, or let your first buy link do it.</p>`;
  const resets = new Date(s.dayEndsAt * 1000).toISOString().slice(11, 16);
  return `<p>For ${addrLink(s.address)}: up to <strong>${pros(l.maxPerBuy)} PROS</strong> per buy and <strong>${pros(l.maxPerDay)} PROS</strong> a day
    (${pros(s.spentToday)} used today, the day resets at ${resets} UTC), only while at most <strong>${pros(l.maxReserveBefore)} PROS</strong> is already in the curve.</p>
    ${s.implAccepted ? "" : `<p class="bad">Prosper has changed its market code since you set these, so the gate refuses your buys until you save limits again. Saving accepts the code as it is now.</p>`}`;
}

function signedInView(s) {
  const l = s.limits;
  box.innerHTML = `<h2>Your buy limits</h2>
    ${summary(s)}
    <form id="limits-form" class="limits-form">
      <label>PROS per buy<input name="perBuy" type="number" min="0.01" max="1000" step="0.01" required value="${l ? plain(l.maxPerBuy) : "0.1"}"></label>
      <label>PROS a day<input name="perDay" type="number" min="0.01" max="10000" step="0.01" required value="${l ? plain(l.maxPerDay) : "0.3"}"></label>
      <label>At most this much PROS already in the curve<input name="inCurve" type="number" min="0" step="0.1" required value="${l ? plain(l.maxReserveBefore) : "0"}"></label>
      <div class="row"><button type="submit">Save limits</button>${l ? `<button type="button" class="quiet" id="limits-stop">Stop all buys</button>` : ""}</div>
    </form>
    <p class="small muted">Saving or stopping is one transaction from your wallet to the <a href="${EXPLORER}/address/${s.gate}#code">gate</a>. No PROS moves, you pay only gas. Stop clears every limit, so no buy link works until you save new ones.</p>
    <p class="small" id="limits-note"></p>`;
  $("#limits-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = e.target;
    sign({ perBuyPros: f.perBuy.value, perDayPros: f.perDay.value, inCurvePros: f.inCurve.value }, "Limits saved");
  });
  $("#limits-stop")?.addEventListener("click", () => sign({ stop: true }, "Stopped: the gate now refuses every buy from this wallet"));
}

let busy = false;
async function sign(body, doneText) {
  if (busy) return;
  busy = true;
  const buttons = box.querySelectorAll("button");
  buttons.forEach((b) => { b.disabled = true; });
  try {
    say("Checking...");
    const r = await api("/limits", { method: "POST", body: JSON.stringify(body) });
    const env = await walletEnv();
    if (!env.providerObj) throw new Error("No wallet in this browser to sign with.");
    const me = await whoAmI();
    const p = env.providerObj;
    const acct = await connect(p);
    if (acct.toLowerCase() !== String(me.address).toLowerCase()) {
      throw new Error(`Your wallet is on ${short(acct)}, but you signed in as ${short(me.address)}. Switch accounts and try again.`);
    }
    await ensurePharos(p);
    const { hash, receipt } = await sendOne(p, r.tx, { onStatus: (m) => say(esc(m)) });
    const link = `<a href="${EXPLORER}/tx/${hash}">${hash.slice(0, 10)}...</a>`;
    if (receipt.status !== "0x1") throw Object.assign(new Error(""), { html: `Reverted: ${link}. Your limits did not change.` });
    await load();
    say(`${doneText}: ${link}`);
  } catch (e) {
    say(e.html ?? esc(e.message || String(e)), true);
    buttons.forEach((b) => { b.disabled = false; });
  } finally {
    busy = false;
  }
}

async function load() {
  const me = await whoAmI();
  if (!me.address) return signedOutView();
  try { signedInView(await api("/limits")); }
  catch (e) { box.innerHTML = `<h2>Your buy limits</h2><p class="muted">Could not read the gate: ${esc(e.message)}</p>`; }
}

// The wallet button in the menu signs in too; follow it.
document.addEventListener("prosperion:me", () => { if (!busy) load(); });

load();
