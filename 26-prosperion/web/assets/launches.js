import { $, api, esc, pros, blockLink, addrLink, EXPLORER } from "./app.js";
import { mountShell } from "./shell.js";

mountShell();

async function loadLaunches() {
  const box = $("#launch-list");
  try {
    const list = await api("/launches");
    if (!list.length) { box.innerHTML = `<p class="muted">No launch seen since the watcher started. This page checks again every 30 seconds.</p>`; return; }
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

loadLaunches();
setInterval(loadLaunches, 30_000);
