// Wallet handling for Prosperion's pages. Plain ES module, no build step, tested from src/wallet.test.ts.
// Everything here comes from testing OKX, Rabby and MetaMask on a real iPhone (2026-11-11):
//  - OKX shows an empty amount on every approve, so the page shows the exact number to type, and we re-read the
//    allowance after the receipt instead of trusting what we asked for;
//  - MetaMask mobile refused every send with -32602 until the page re-requested account permission;
//  - fast taps queued approves with stale gas estimates that ran out of gas, so: one tx at a time, fresh estimate.

export const PHAROS_ID = 1672;
export const PHAROS_HEX = "0x688";
export const PHAROS_PARAMS = {
  chainId: PHAROS_HEX,
  chainName: "Pharos Mainnet",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: ["https://rpc.pharos.xyz"],
  blockExplorerUrls: ["https://www.pharosscan.xyz"],
};

/** Pure: decide where we are from what the page can see. */
export function detectWallet({ ua = "", hasEthereum = false, providers = [] }) {
  const inWalletBrowser = /OKX-Wallet\//.test(ua) || /OKApp\//.test(ua)
    ? "okx"
    : /MetaMaskMobile/.test(ua)
      ? "metamask"
      : /RabbyMobile/.test(ua)
        ? "rabby"
        : null;
  const mobile = /iPhone|iPad|Android|Mobile\//.test(ua);
  const first = providers[0];
  return {
    inWalletBrowser,
    mobile,
    desktopExtension: !inWalletBrowser && !mobile && hasEthereum,
    provider: first ? first.name : undefined,
    rdns: first ? first.rdns : undefined,
  };
}

/** Browser-only: collect EIP-6963 announcements for a moment. */
export function announcedProviders(win = globalThis.window, waitMs = 250) {
  return new Promise((resolve) => {
    const seen = [];
    const onAnnounce = (e) => seen.push({ name: e.detail.info.name, rdns: e.detail.info.rdns, provider: e.detail.provider });
    win.addEventListener("eip6963:announceProvider", onAnnounce);
    win.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => { win.removeEventListener("eip6963:announceProvider", onAnnounce); resolve(seen); }, waitMs);
  });
}

export async function connect(p) {
  const accounts = await p.request({ method: "eth_requestAccounts" });
  return accounts[0];
}

export async function ensurePharos(p) {
  const id = await p.request({ method: "eth_chainId" });
  if (String(id).toLowerCase() === PHAROS_HEX) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: PHAROS_HEX }] });
  } catch (e) {
    if (e && (e.code === 4902 || /unrecognized|unknown chain/i.test(e.message || ""))) {
      await p.request({ method: "wallet_addEthereumChain", params: [PHAROS_PARAMS] });
    } else throw e;
  }
}

let pending = false;

async function freshAccount(p) {
  const a = await p.request({ method: "eth_accounts" });
  if (a && a[0]) return a[0];
  return (await p.request({ method: "eth_requestAccounts" }))[0];
}

const isAddressError = (e) => e && (e.code === -32602 || /must provide an ethereum address/i.test(e.message || ""));

/**
 * Sends one transaction and waits for its receipt. Refuses to start while another is in flight.
 * tx: { to, data, value } with value as a decimal string of wei.
 */
export async function sendOne(p, tx, { pollMs = 1500, timeoutMs = 180000, onStatus = () => {} } = {}) {
  if (pending) throw new Error("One at a time: wait for the previous transaction to confirm.");
  pending = true;
  try {
    const build = async () => {
      const from = await freshAccount(p);
      const base = { from, to: tx.to, data: tx.data, value: "0x" + BigInt(tx.value || "0").toString(16) };
      const est = BigInt(await p.request({ method: "eth_estimateGas", params: [base] }));
      return { ...base, gas: "0x" + ((est * 125n) / 100n).toString(16) };
    };
    let hash;
    onStatus("Waiting for your wallet...");
    try {
      hash = await p.request({ method: "eth_sendTransaction", params: [await build()] });
    } catch (e) {
      if (!isAddressError(e)) throw e;
      onStatus("The wallet lost track of the account. Asking it for permission again...");
      await p.request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] });
      hash = await p.request({ method: "eth_sendTransaction", params: [await build()] });
    }
    onStatus("Sent. Waiting for it to be mined...");
    const until = Date.now() + timeoutMs;
    for (;;) {
      const receipt = await p.request({ method: "eth_getTransactionReceipt", params: [hash] });
      if (receipt) return { hash, receipt };
      if (Date.now() > until) throw new Error(`No receipt after ${timeoutMs / 1000}s for ${hash}. Check it on pharosscan.`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  } finally {
    pending = false;
  }
}

const pad = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

/** allowance(owner, spender) as the chain has it now. */
export async function readAllowance(p, token, owner, spender) {
  const data = "0xdd62ed3e" + pad(owner) + pad(spender);
  return BigInt(await p.request({ method: "eth_call", params: [{ to: token, data }, "latest"] }));
}
