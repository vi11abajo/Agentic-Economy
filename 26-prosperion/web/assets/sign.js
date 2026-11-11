// The page a launch alert links to. Everything here is re-checked on load: the alert is a few minutes old
// at best, and a launch that was empty then may have buyers now. If the server says no, we show why and
// offer no button at all.
import { $, api, esc, pros, blockLink, addrLink, walletEnv, walletLinks, connect, ensurePharos, EXPLORER } from "./app.js";
import { sendOne } from "./wallet.js";

const id = new URLSearchParams(location.search).get("r") || "";
const out = $("#out");

function txLink(hash) { return `<a href="${EXPLORER}/tx/${hash}">${hash.slice(0, 10)}...</a>`; }

async function load() {
  let r;
  try { r = await api(`/req/${encodeURIComponent(id)}`); }
  catch (e) {
    out.innerHTML = `<h1>This link does not work</h1><p>${e.status === 404 ? "We have no request with this id. Links from Telegram are copied in full; try opening it again from the message." : esc(e.message)}</p>`;
    return;
  }
  const p = r.request.params;
  const c = r.freshCheck;
  const amount = BigInt(p.amountWei);
  const head = `<h1>Buy into a fresh Prosper launch</h1>
    <p class="lede">Market ${addrLink(p.market)}${c?.pToken ? `, token ${addrLink(c.pToken)}` : ""}. Alert sent at ${blockLink(r.request.createdBlock)}${c ? `, checked again at ${blockLink(c.block)}` : ""}.</p>`;

  if (r.refusal) {
    out.innerHTML = `${head}<div class="panel refusal"><strong>Not signing this one.</strong><p>${esc(r.refusal)}</p>
      <p class="small muted">Nothing was sent and nothing is waiting for you. The next launch that passes the checks will come as a new alert.</p></div>`;
    return;
  }

  const steps = [];
  if (r.setLimits) steps.push({ key: "limits", text: `Set your limits in the gate: up to ${pros(r.setLimits.limits.maxPerBuy)} PROS per buy, ${pros(r.setLimits.limits.maxPerDay)} PROS a day, only while at most ${pros(r.setLimits.limits.maxReserveBefore)} PROS is in the curve. A one-time step; no money moves.`, tx: r.setLimits });
  steps.push({ key: "buy", text: `Buy: send ${pros(amount)} PROS through the gate. You get at least ${pros(r.tx.minOut)} tokens or the whole thing reverts. The offer expires five minutes after this page loaded.`, tx: r.tx });

  out.innerHTML = `${head}
    <div class="panel ok">
      <p>${BigInt(c.reserveBefore) === 0n ? "Still nobody ahead of you: the curve is empty." : `${pros(c.reserveBefore)} PROS is in the curve now, within your limit of ${pros(p.maxReserveBeforeWei)}.`} The market is a genuine Prosper one and its code has not changed since the alert.</p>
      <p class="bigamount">${pros(amount)} PROS</p>
      <p class="small muted">That is the amount your wallet will ask you to send. Some wallets (OKX) show only the total; check it matches.</p>
    </div>
    <h2>What you will sign, one at a time</h2>
    <ol class="steps" id="steps">${steps.map((s, i) => `<li id="step-${s.key}" class="${i === 0 ? "now" : ""}">${s.text}<div class="small" id="st-${s.key}"></div></li>`).join("")}</ol>
    <div id="act"></div>
    <p class="small muted">The gate checks all of this again inside the transaction. If someone buys first, or the market code is swapped, it reverts and you lose only gas.</p>`;

  const env = await walletEnv();
  const act = $("#act");
  if (!env.providerObj) {
    const l = walletLinks(location.href);
    act.innerHTML = `<div class="panel"><p>${env.mobile ? "Open this page inside your wallet app:" : "No wallet in this browser. Open this page in your phone wallet:"}</p>
      <p class="walletlinks"><a href="${l.okx}">OKX Wallet</a><a href="${l.rabby}">Rabby</a><a href="${l.metamask}">MetaMask</a></p></div>`;
    return;
  }
  act.innerHTML = `<button id="go" type="button">Connect and start</button> <span id="who" class="small muted"></span>`;
  $("#go").addEventListener("click", async () => {
    const go = $("#go");
    go.disabled = true;
    try {
      const p0 = env.providerObj;
      const me = await connect(p0);
      $("#who").textContent = `Connected: ${me}`;
      if (me.toLowerCase() !== String(p.owner).toLowerCase()) {
        $("#who").innerHTML = `Connected ${esc(me)}, but this alert was made for ${esc(p.owner)}. Switch accounts in your wallet and press the button again.`;
        go.disabled = false;
        return;
      }
      await ensurePharos(p0);
      for (const s of steps) {
        const li = $(`#step-${s.key}`), st = $(`#st-${s.key}`);
        if (li.classList.contains("done")) continue;
        li.className = "now";
        const { hash, receipt } = await sendOne(p0, s.tx, { onStatus: (m) => { st.textContent = m; } });
        if (receipt.status !== "0x1") { st.innerHTML = `Reverted: ${txLink(hash)}. Nothing was bought.`; go.disabled = false; return; }
        st.innerHTML = `Done: ${txLink(hash)}`;
        li.className = "done";
      }
      act.innerHTML = `<p><strong>Bought.</strong> The tokens are in your wallet; the agent's notes on this launch are in your Telegram.</p>`;
    } catch (e) {
      $("#who").textContent = e.message || String(e);
      go.disabled = false;
    }
  });
}

load();
