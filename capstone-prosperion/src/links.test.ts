import { test } from "node:test";
import assert from "node:assert/strict";
import { requestUrl, walletLinks } from "./links.js";

// The exact strings from prosperion-recon/qr-test.html cards 8, 10 and 12, which the user scanned on a phone and
// saw open the test page inside OKX, Rabby and MetaMask.
const TEST = "https://prosperion.pharosfdv.xyz/wallet-test/";

test("wallet links match the ones that worked on real phones", () => {
  const l = walletLinks(TEST);
  assert.equal(l.okx, "https://web3.okx.com/download?deeplink=okx%3A%2F%2Fwallet%2Fdapp%2Furl%3FdappUrl%3Dhttps%253A%252F%252Fprosperion.pharosfdv.xyz%252Fwallet-test%252F");
  assert.equal(l.rabby, "https://go.rabby.io/mobile/?_cmd=open-dapp&dapp=https%3A%2F%2Fprosperion.pharosfdv.xyz%2Fwallet-test%2F");
  assert.equal(l.metamask, "https://metamask.app.link/dapp/prosperion.pharosfdv.xyz/wallet-test/");
});

test("request links only ever point at our own site", () => {
  assert.equal(requestUrl("abc_123"), "https://prosperion.pharosfdv.xyz/sign/?r=abc_123");
  assert.throws(() => requestUrl("../evil"));
});
