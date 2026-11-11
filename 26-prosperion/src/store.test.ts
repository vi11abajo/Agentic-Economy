import { test } from "node:test";
import assert from "node:assert/strict";
import { createSiweMessage } from "viem/siwe";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { openStore } from "./store.js";
import { SIWE_DOMAIN, newNonce, verifySiwe } from "./auth.js";

const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";

test("a watch survives a round trip, big numbers and all", () => {
  const s = openStore(":memory:");
  s.upsertWatch({ address: ME, maxPerBuyWei: 10n ** 18n, maxReserveBeforeWei: 5n * 10n ** 17n, curatorDeny: [] });
  s.upsertWatch({ address: ME, maxPerBuyWei: 2n * 10n ** 18n, maxReserveBeforeWei: 0n, curatorDeny: ["0x17ee000000000000000000000000000000c3bb00"] });
  const [w] = s.watchesFor(ME);
  assert.equal(w.maxPerBuyWei, 2n * 10n ** 18n);
  assert.equal(w.maxReserveBeforeWei, 0n);
  assert.equal(w.curatorDeny.length, 1);
  assert.equal(s.allWatches().length, 1);
});

test("a Telegram link code works once and only within ten minutes", () => {
  const s = openStore(":memory:");
  s.upsertWatch({ address: ME, maxPerBuyWei: 1n, maxReserveBeforeWei: 0n, curatorDeny: [] });
  const code = s.newLinkCode(ME);
  assert.equal(s.linkTelegram(code, 4242), ME);
  assert.equal(s.linkTelegram(code, 4242), null, "second use must fail");
  assert.equal(s.watchesFor(ME)[0].telegramChatId, 4242);

  const late = s.newLinkCode(ME, Date.now() - 11 * 60_000);
  assert.equal(s.linkTelegram(late, 1), null, "expired code must fail");
});

test("signing in proves the address, and a nonce cannot be replayed", async () => {
  const s = openStore(":memory:");
  const acct = privateKeyToAccount(generatePrivateKey()); // throwaway key made for this test only
  const nonce = newNonce(s);
  const message = createSiweMessage({
    domain: SIWE_DOMAIN, address: acct.address, uri: `https://${SIWE_DOMAIN}`, version: "1", chainId: 1672, nonce,
    statement: "Sign in to Prosperion. This is not a transaction and costs nothing.",
  });
  const signature = await acct.signMessage({ message });
  assert.equal(await verifySiwe(s, message, signature), acct.address);
  assert.equal(await verifySiwe(s, message, signature), null, "same nonce twice");
});

test("a signature made for another site does not sign you in here", async () => {
  const s = openStore(":memory:");
  const acct = privateKeyToAccount(generatePrivateKey());
  const nonce = newNonce(s);
  const message = createSiweMessage({ domain: "evil.example", address: acct.address, uri: "https://evil.example", version: "1", chainId: 1672, nonce });
  assert.equal(await verifySiwe(s, message, await acct.signMessage({ message })), null);
});

test("agent turns are counted per IP per day", () => {
  const s = openStore(":memory:");
  s.addTurn("1.2.3.4", "2026-11-11");
  s.addTurn("1.2.3.4", "2026-11-11");
  s.addTurn("5.6.7.8", "2026-11-11");
  assert.equal(s.countTurns("1.2.3.4", "2026-11-11"), 2);
  assert.equal(s.countTurns("1.2.3.4", "2026-11-12"), 0);
  assert.equal(s.totalTurns("2026-11-11"), 3);
});

test("a buy request keeps its parameters exactly", () => {
  const s = openStore(":memory:");
  const id = s.saveRequest({
    kind: "buy", createdBlock: 22767762n,
    params: { market: "0x94228EB493173E75a12e76E667bfe9b0939aae64", amountWei: "10000000000000000", minOutBps: 9800, maxReserveBeforeWei: "0", acceptedImpl: "0xb05749a8Cc5Dd1205Bc36326Cf94A2cA83f7D672" },
  });
  const r = s.getRequest(id)!;
  assert.equal(r.kind, "buy");
  assert.equal(r.createdBlock, 22767762n);
  assert.equal(r.params.amountWei, "10000000000000000");
  assert.equal(s.getRequest("nope"), null);
});

test("the sign-in message the page builds is accepted, even with a lowercase address", async () => {
  // @ts-ignore: browser module
  const { siweMessage } = await import("../web/assets/wallet.js");
  const s = openStore(":memory:");
  const acct = privateKeyToAccount(generatePrivateKey());
  const message = siweMessage({ domain: SIWE_DOMAIN, origin: `https://${SIWE_DOMAIN}`, address: acct.address.toLowerCase(), nonce: newNonce(s), issuedAt: new Date().toISOString() });
  const signature = await acct.signMessage({ message });
  assert.equal((await verifySiwe(s, message, signature))?.toLowerCase(), acct.address.toLowerCase());
});
