import { $, api, esc, usdc, blockLink, addrLink } from "./app.js";

const perShare = (raw) => (Number(BigInt(raw)) / 1e6).toFixed(6);

const params = new URLSearchParams(location.search);
// The listing comes from Prosper's API and takes a few seconds; the chain read does not wait for it.
const listing = api("/vaults").catch(() => []);
const nameOf = async (addr) => (await listing).find((x) => x.r25Vault.toLowerCase() === addr.toLowerCase())?.vaultName ?? "Vault";

async function init() {
  const v = params.get("v");
  if (v) show(v);
  const vaults = await listing;
  $("#vault-select").innerHTML += vaults
    .map((x) => `<option value="${x.r25Vault}">${esc(x.vaultName)} (${esc(x.pVaultSymbol)})</option>`).join("");
  const opt = v && [...$("#vault-select").options].find((o) => o.value.toLowerCase() === v.toLowerCase());
  if (opt) opt.selected = true;
}

$("#pick").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#vault-select").value;
  if (!v) return;
  history.replaceState(null, "", `?v=${v}`);
  show(v);
});

async function show(addr) {
  const out = $("#out");
  out.innerHTML = `<h1>Vault ${esc(addr)}</h1><p class="muted">Reading the vault's contracts on Pharos...</p>`;
  let p, name;
  try { [p, name] = await Promise.all([api(`/vault/${addr}`), nameOf(addr)]); }
  catch (e) { out.innerHTML += `<p>${esc(e.message)}</p>`; return; }

  const total = BigInt(p.totalAssets);
  const onBps = p.verifiableBps;
  const mirror = p.adapters.filter((a) => a.kind !== "Local").reduce((s, a) => s + BigInt(a.value), 0n);
  out.innerHTML = `
    <h1>${esc(name)}</h1>
    <p class="lede">NAV ${usdc(total)} USDC, ${perShare(p.navPerShare)} USDC per share. Read at ${blockLink(p.block)}.</p>

    <div class="assay" role="img" aria-label="${(onBps / 100).toFixed(1)} percent can be checked on Pharos, ${(100 - onBps / 100).toFixed(1)} percent is reported by the operator">
      <div class="bar"><div class="on" style="width:${onBps / 100}%"></div><div class="trust" style="width:${100 - onBps / 100}%"></div></div>
      <div class="legend">
        <div><b class="onc">${(onBps / 100).toFixed(1)}%</b>you can check on Pharos</div>
        <div class="r"><b class="trc">${(100 - onBps / 100).toFixed(1)}%</b>taken on the operator's word</div>
      </div>
      <p class="stamp">${p.reconciles ? "Our sum of the parts equals the vault oracle's NAV to the last unit." : "Our sum of the parts does NOT match the oracle's NAV. Treat these numbers with care."}</p>
    </div>

    <h2>Where the money is</h2>
    <table>
      <thead><tr><th>Part</th><th>Where</th><th class="num">USDC</th></tr></thead>
      <tbody>
        ${p.escrow.map((e) => `<tr><td>Escrow ${addrLink(e.asset)}</td><td>On Pharos, in the vault's escrow</td><td class="num">${usdc(e.value)}</td></tr>`).join("")}
        ${p.adapters.filter((a) => BigInt(a.value) > 0n || a.kind !== "Local").map((a) => `<tr><td>${a.kind} adapter ${addrLink(a.adapter)}</td><td>${a.kind === "Local" ? "On Pharos" : "Another chain; the operator pushes this number"}</td><td class="num">${usdc(a.value)}</td></tr>`).join("")}
      </tbody>
    </table>
    ${mirror > 0n ? `<p class="small muted">The ${usdc(mirror)} USDC reported from elsewhere comes from adapters on other chains, valued at a price the operator posts. Nothing on Pharos can confirm it.</p>` : ""}

    <h2>How fresh the prices are</h2>
    <p>${p.validNav ? "The oracle calls its NAV valid right now." : "The vault's own oracle calls its NAV stale right now: at least one price is older than its 180-second limit. The NAV above is the number it returns regardless."}</p>
    ${p.prices.length ? `<table><thead><tr><th>Priced asset</th><th class="num">Age</th></tr></thead><tbody>${p.prices.map((x) => `<tr><td>${addrLink(x.asset)}</td><td class="num">${(x.ageSec / 3600).toFixed(1)} h${x.stale ? " (stale)" : ""}</td></tr>`).join("")}</tbody></table>` : `<p class="muted small">This vault holds only USDC right now, so no prices are involved.</p>`}

    <h2>Why did NAV per share move?</h2>
    <form id="move" class="row">
      <input id="from" inputmode="numeric" placeholder="from block" style="flex:1 1 160px" aria-label="From block">
      <input id="to" inputmode="numeric" placeholder="to block" style="flex:1 1 160px" aria-label="To block" value="${p.block}">
      <button type="submit">Explain</button>
    </form>
    <p class="muted small">Up to 50,000 blocks apart. Example for Barker Neutral Carry: 22652603 to 22652604.</p>
    <div id="move-out"></div>`;

  $("#move").addEventListener("submit", async (e) => {
    e.preventDefault();
    const box = $("#move-out");
    box.innerHTML = `<p class="muted">Reading both blocks...</p>`;
    try {
      const m = await api(`/navmove/${addr}?from=${$("#from").value}&to=${$("#to").value}`);
      const label = { flows: "Money in or out (settled deposits and redeems)", admin: "Shares burned with no money moving", fees: "Fee shares minted", mirror: "Operator-reported value changed", price: "Prices of what it holds" };
      const amt = (part) => part.unit === "usdc" ? `${usdc(part.delta)} USDC` : `${(Number(BigInt(part.delta)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 })} shares`;
      box.innerHTML = `<div class="panel">
        <p>NAV per share ${perShare(m.navFrom)} at ${blockLink(m.from)} to ${perShare(m.navTo)} at ${blockLink(m.to)}.</p>
        ${m.parts.length ? `<table><tbody>${m.parts.map((x) => `<tr><td>${label[x.kind]}</td><td class="num">${amt(x)}</td><td>${x.txs.slice(0, 3).map((t) => `<a href="https://www.pharosscan.xyz/tx/${t}">tx</a>`).join(" ")}</td></tr>`).join("")}</tbody></table>` : "<p>Nothing moved between these blocks.</p>"}
      </div>`;
    } catch (err) { box.innerHTML = `<p>${esc(err.message)}</p>`; }
  });
}

init();
