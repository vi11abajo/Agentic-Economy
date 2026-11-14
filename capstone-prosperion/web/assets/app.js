// Shared helpers for Prosperion's pages: API calls, number formatting, the wallet bar and sign-in.
import { announcedProviders, connect, detectWallet, ensurePharos, siweMessage } from "./wallet.js";

export const $ = (s, root = document) => root.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const EXPLORER = "https://www.pharosscan.xyz";
export const short = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : "");
export const usdc = (raw) => (Number(BigInt(raw)) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 });
export const pros = (raw) => (Number(BigInt(raw)) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 4 });
export const blockLink = (b) => `<a href="${EXPLORER}/block/${b}">block ${Number(b).toLocaleString("en-US")}</a>`;
export const addrLink = (a) => `<a class="addr" href="${EXPLORER}/address/${a}">${short(a)}</a>`;

export async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", ...opts, headers: { "content-type": "application/json", ...(opts.headers || {}) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status });
  return body;
}

// The wallet the visitor has, worked out once per page.
let envCache;
export async function walletEnv() {
  if (envCache) return envCache;
  const providers = typeof window !== "undefined" ? await announcedProviders(window) : [];
  const e = detectWallet({ ua: navigator.userAgent, hasEthereum: !!window.ethereum, providers });
  envCache = { ...e, providerObj: providers[0]?.provider || window.ethereum || null };
  return envCache;
}

export function walletLinks(url) {
  return {
    okx: `https://web3.okx.com/download?deeplink=${encodeURIComponent(`okx://wallet/dapp/url?dappUrl=${encodeURIComponent(url)}`)}`,
    rabby: `https://go.rabby.io/mobile/?_cmd=open-dapp&dapp=${encodeURIComponent(url)}`,
    metamask: `https://metamask.app.link/dapp/${url.replace(/^https:\/\//, "")}`,
  };
}

/** Sign in with Ethereum: a readable message, no transaction, no cost. */
export async function signIn(p) {
  const address = await connect(p);
  const { nonce } = await api("/siwe/nonce");
  const message = siweMessage({ domain: location.host, origin: location.origin, address, nonce, issuedAt: new Date().toISOString() });
  const signature = await p.request({ method: "personal_sign", params: [message, address] });
  return api("/siwe/verify", { method: "POST", body: JSON.stringify({ message, signature }) });
}

export { ensurePharos, connect };
