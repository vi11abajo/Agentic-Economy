// The frame every page sits in: the menu on the left (a drawer on phones) and the wallet button at its foot.
// Each page says who it is with <body data-page="...">, and the matching menu item lights up.
import { $, api, short, walletEnv, signIn, EXPLORER } from "./app.js";

const icon = (paths) =>
  `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

export const ICONS = {
  chat: icon('<path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 4v-4A2.5 2.5 0 0 1 4 13.5z"/>'),
  vault: icon('<rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8V7.5M12 16.5v-1.3M15.2 12h1.3M7.5 12h1.3M6.5 19v1.5M17.5 19v1.5"/>'),
  launch: icon('<path d="M12 3.5c3 2 4.5 5 4.5 8.5l-2 4h-5l-2-4c0-3.5 1.5-6.5 4.5-8.5z"/><circle cx="12" cy="10" r="1.6"/><path d="M9.5 16l-2.5 3M14.5 16l2.5 3M12 17v3.5"/>'),
  bell: icon('<path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2h-14z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>'),
  scan: icon('<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5M8 10.5h5M10.5 8v5"/>'),
  code: icon('<path d="M8.5 7.5L4 12l4.5 4.5M15.5 7.5L20 12l-4.5 4.5M13.5 5l-3 14"/>'),
  wallet: icon('<path d="M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3"/><rect x="4" y="8" width="16" height="11" rx="2"/><circle cx="16" cy="13.5" r="1.2"/>'),
  menu: icon('<path d="M4 7h16M4 12h16M4 17h16"/>'),
  close: icon('<path d="M6 6l12 12M18 6L6 18"/>'),
  send: `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
};

// The mark: a lens over a curve, because the whole product is looking closely at something.
const MARK = `<svg width="18" height="24" viewBox="0 0 18 24" fill="none" aria-hidden="true"><circle cx="8" cy="10" r="6.2" stroke="#0012B8" stroke-width="2.2"/><path d="M12.6 14.6L17 20" stroke="#0012B8" stroke-width="2.2" stroke-linecap="round"/><path d="M4.6 11.6c1.4-.2 2.3-1.6 3.4-3.2 1-1.4 2-2 3.4-2" stroke="#0B0B0B" stroke-width="1.4" stroke-linecap="round"/></svg>`;

const ITEMS = [
  { group: null, items: [{ k: "chat", href: "/", text: "Chat", icon: "chat" }] },
  { group: "Investigate", items: [
    { k: "vaults", href: "/vault/", text: "Vaults", icon: "vault" },
    { k: "launches", href: "/launches/", text: "Launches", icon: "launch" },
  ] },
  { group: "Act", items: [{ k: "alerts", href: "/alerts/", text: "Alerts", icon: "bell" }] },
  { group: "Pharos", items: [
    { k: "explorer", href: "https://www.pharosscan.xyz", text: "Explorer", icon: "scan", out: true },
    { k: "source", href: "https://github.com/vi11abajo/Agentic-Economy/tree/main/26-prosperion", text: "Source", icon: "code", out: true },
  ] },
];

export function mountShell() {
  const page = document.body.dataset.page;
  const side = $("#side");
  side.innerHTML = `
    <div class="brand"><a href="/" class="logo">${MARK}<span>Prosperion</span></a>
      <button type="button" class="iconbtn only-phone" id="side-close" aria-label="Close menu">${ICONS.close}</button></div>
    <nav aria-label="Main">${ITEMS.map((g) => `<div class="group">${g.group ? `<div class="label">${g.group}</div>` : ""}${g.items.map((i) =>
      `<a class="item" href="${i.href}"${i.k === page ? ' aria-current="page"' : ""}${i.out ? ' target="_blank" rel="noopener"' : ""} data-k="${i.k}">${ICONS[i.icon]}<span>${i.text}</span></a>`).join("")}</div>`).join("")}
    </nav>
    <div class="side-foot">
      <div class="wallet-menu" id="wallet-menu" role="menu" hidden>
        <p class="wallet-menu-addr" id="wallet-menu-addr"></p>
        <button type="button" role="menuitem" id="wm-copy">Copy address</button>
        <a role="menuitem" id="wm-explorer" target="_blank" rel="noopener">View on pharosscan</a>
        <button type="button" role="menuitem" id="wm-signout">Sign out</button>
      </div>
      <button type="button" class="wallet-pill" id="wallet-pill" aria-haspopup="menu" aria-expanded="false"><span id="wallet-text">Connect Wallet</span><i>${ICONS.wallet}</i></button>
      <p class="wallet-note small muted" id="wallet-note" hidden></p>
    </div>`;

  const bar = document.createElement("header");
  bar.className = "topbar only-phone";
  bar.innerHTML = `<button type="button" class="iconbtn" id="side-open" aria-label="Open menu" aria-controls="side">${ICONS.menu}</button><a href="/" class="logo">${MARK}<span>Prosperion</span></a>`;
  document.body.prepend(bar);
  const scrim = document.createElement("div");
  scrim.className = "scrim";
  document.body.append(scrim);
  const open = (on) => { document.body.classList.toggle("side-open", on); };
  $("#side-open").addEventListener("click", () => open(true));
  $("#side-close").addEventListener("click", () => open(false));
  scrim.addEventListener("click", () => open(false));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") open(false); });

  wireWallet();
}

// Who is signed in, asked once per page. {address: null} until a wallet signs the sign-in message.
let mePromise = null;
export const whoAmI = (fresh = false) => {
  if (fresh || !mePromise) mePromise = api("/me").catch(() => ({ address: null }));
  return mePromise;
};
const announce = (me) => document.dispatchEvent(new CustomEvent("prosperion:me", { detail: me }));

/**
 * Connect the wallet and sign in: one readable message in the wallet, no transaction, nothing spent.
 * The server ties the wallet to the IP it came from, so one person's chat limits follow them across both.
 * Throws an Error whose message can be shown as is.
 */
export async function connectWallet() {
  const env = await walletEnv();
  if (!env.providerObj) {
    throw new Error(env.mobile
      ? "Open this page inside your wallet app (OKX, Rabby or MetaMask)."
      : "No wallet in this browser. Install a wallet extension, or open the page in your phone wallet.");
  }
  try { await signIn(env.providerObj); }
  catch (e) { throw new Error(`Not signed in: ${e.message}`); }
  const me = await whoAmI(true);
  announce(me);
  return me;
}

/** The chat said the session is gone (expired, or signed out elsewhere): show the button again. */
export function signedOut() {
  mePromise = Promise.resolve({ address: null });
  announce({ address: null });
}

async function wireWallet() {
  const text = $("#wallet-text"), note = $("#wallet-note"), pill = $("#wallet-pill"), menu = $("#wallet-menu");
  let address = null;
  const openMenu = (on) => {
    menu.hidden = !on;
    pill.setAttribute("aria-expanded", String(on));
  };
  const show = (me) => {
    address = me.address;
    pill.classList.toggle("on", !!address);
    text.textContent = address ? short(address) : "Connect Wallet";
    pill.title = address ? `Signed in as ${address}` : "";
    if (!address) openMenu(false);
  };
  document.addEventListener("prosperion:me", (e) => show(e.detail));
  const me = await whoAmI();
  show(me);
  announce(me);

  // Signed in, the pill opens the wallet menu; signed out, it connects.
  pill.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (address) {
      $("#wallet-menu-addr").textContent = address;
      $("#wm-explorer").href = `${EXPLORER}/address/${address}`;
      return openMenu(menu.hidden);
    }
    try { await connectWallet(); note.hidden = true; }
    catch (err) { note.hidden = false; note.textContent = err.message; }
  });
  document.addEventListener("click", (e) => { if (!menu.hidden && !menu.contains(e.target)) openMenu(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !menu.hidden) { openMenu(false); pill.focus(); } });

  $("#wm-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(address); $("#wm-copy").textContent = "Copied"; }
    catch { $("#wm-copy").textContent = "Copy failed: select the address above"; }
    setTimeout(() => { $("#wm-copy").textContent = "Copy address"; }, 1500);
  });
  $("#wm-signout").addEventListener("click", async () => {
    try { await api("/signout", { method: "POST" }); }
    catch (err) { note.hidden = false; note.textContent = `Could not sign out: ${err.message}`; return; }
    note.hidden = true;
    signedOut();
  });
}
