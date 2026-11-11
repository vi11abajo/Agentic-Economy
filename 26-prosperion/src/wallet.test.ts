// The page's wallet logic lives in web/assets/wallet.js (plain ES module, no build step); we test it from here.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore: plain JS module shipped to the browser as is
import { detectWallet, sendOne, readAllowance, PHAROS_HEX } from "../web/assets/wallet.js";

// User agents recorded on the user's iPhone on 2026-11-11 (prosperion-recon wallet test).
const UA = {
  okx: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 OKX-Wallet/6.196.0 (iPhone;U;iOS 27.2.1;ru-UA/en-US) locale=en-US",
  metamask: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 WebView MetaMaskMobile",
  rabby: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1 RabbyMobile/0.6.98 RabbyMobileIOS/0.6.98",
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  iphoneSafari: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1",
};

test("each phone wallet's own browser is recognised", () => {
  assert.equal(detectWallet({ ua: UA.okx, hasEthereum: true, providers: [{ name: "OKX Wallet", rdns: "com.okex.wallet" }] }).inWalletBrowser, "okx");
  assert.equal(detectWallet({ ua: UA.metamask, hasEthereum: true, providers: [] }).inWalletBrowser, "metamask");
  assert.equal(detectWallet({ ua: UA.rabby, hasEthereum: true, providers: [] }).inWalletBrowser, "rabby");
});

test("a desktop browser with an extension signs on the page", () => {
  const e = detectWallet({ ua: UA.desktop, hasEthereum: true, providers: [{ name: "Rabby Wallet", rdns: "io.rabby" }] });
  assert.equal(e.inWalletBrowser, null);
  assert.equal(e.desktopExtension, true);
  assert.equal(e.provider, "Rabby Wallet");
});

test("a phone browser with no wallet is told to pick one", () => {
  const e = detectWallet({ ua: UA.iphoneSafari, hasEthereum: false, providers: [] });
  assert.equal(e.inWalletBrowser, null);
  assert.equal(e.desktopExtension, false);
  assert.equal(e.mobile, true);
});

function mockProvider(script: Record<string, (params: any, n: number) => any>) {
  const calls: { method: string; params: any }[] = [];
  const count: Record<string, number> = {};
  return {
    calls,
    request: async ({ method, params }: { method: string; params?: any }) => {
      calls.push({ method, params });
      count[method] = (count[method] ?? 0) + 1;
      const f = script[method];
      if (!f) throw new Error(`unexpected ${method}`);
      return f(params, count[method]);
    },
  };
}

const ACC = "0x59f74ed82a08f80cff5d7e8055f6a24a18595f64";
const baseScript = {
  eth_accounts: () => [ACC],
  eth_chainId: () => PHAROS_HEX,
  eth_estimateGas: () => "0xc350", // 50,000
  eth_getTransactionReceipt: (_p: any, n: number) => (n < 2 ? null : { status: "0x1", blockNumber: "0x10" }),
};

test("MetaMask's -32602 gets one permission re-request, then the send goes through with a padded gas limit", async () => {
  const p = mockProvider({
    ...baseScript,
    wallet_requestPermissions: () => [{ parentCapability: "eth_accounts" }],
    eth_sendTransaction: (_params: any, n: number) => {
      if (n === 1) throw Object.assign(new Error("Invalid parameters: must provide an Ethereum address."), { code: -32602 });
      return "0xabc";
    },
  });
  const r = await sendOne(p, { to: "0x0000000000000000000000000000000000006a7e", data: "0x", value: "0" }, { pollMs: 1 });
  assert.equal(r.hash, "0xabc");
  assert.equal(r.receipt.status, "0x1");
  assert.ok(p.calls.some((c) => c.method === "wallet_requestPermissions"));
  const sent = p.calls.filter((c) => c.method === "eth_sendTransaction").pop()!;
  assert.equal(BigInt(sent.params[0].gas), 62_500n, "fresh estimate x1.25");
});

test("a second send while one is still waiting for its receipt is refused", async () => {
  const p = mockProvider({ ...baseScript, eth_sendTransaction: () => "0x1", eth_getTransactionReceipt: (_p: any, n: number) => (n < 5 ? null : { status: "0x1" }) });
  const first = sendOne(p, { to: "0x0000000000000000000000000000000000006a7e", data: "0x", value: "0" }, { pollMs: 5 });
  await assert.rejects(sendOne(p, { to: "0x0000000000000000000000000000000000006a7e", data: "0x", value: "0" }, { pollMs: 5 }), /one at a time/i);
  await first;
});

test("the allowance is what the chain says, not what we asked for", async () => {
  // OKX made the user type the approve amount; the mined approve was 100000 when 1 was asked.
  const p = mockProvider({ eth_call: () => "0x" + (100000).toString(16).padStart(64, "0") });
  const a = await readAllowance(p, "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", ACC, "0x9920e66f508435fa37aafc363f932af352bfa018");
  assert.equal(a, 100000n);
  assert.equal(p.calls[0].params[0].data.slice(0, 10), "0xdd62ed3e");
});
