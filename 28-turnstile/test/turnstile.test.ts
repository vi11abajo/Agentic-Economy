import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { verifyTypedData, keccak256, toHex, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Facilitator } from "@x402/core/facilitator";
import type { FacilitatorClient } from "@x402/core/server";
import { decodePaymentRequiredHeader } from "@x402/core/http";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { ExactEvmScheme } from "@x402/evm/exact/facilitator";
import { NETWORK, USDC } from "../src/atlantic.js";
import { facilitatorRoutes, type Facilitator } from "../src/facilitator.js";
import { makeApp } from "../src/server.js";
import { buy } from "../src/buyer.js";

// The real SDK facilitator (so the real signature, amount and recipient checks run), on a pretend chain: balances
// are plenty, no nonce is used yet, and "sending" a tx just hands back a hash. Keys are made fresh for each run.
const SELLER = privateKeyToAccount(generatePrivateKey()).address;
const settled: Hex[] = [];
function pretendFacilitator(): Facilitator {
  const signer = toFacilitatorEvmSigner({
    address: SELLER,
    // only USDC has code: a payer with code would be treated as a smart wallet (ERC-1271)
    getCode: async ({ address }: { address: string }) => (address.toLowerCase() === USDC.toLowerCase() ? "0x6080" : "0x"),
    readContract: async (a: { functionName: string }) => (a.functionName === "balanceOf" ? 10n ** 12n : a.functionName === "authorizationState" ? false : 0n),
    verifyTypedData: (a: unknown) => verifyTypedData(a as never),
    writeContract: async () => {
      const h = keccak256(toHex(`settle ${settled.length}`));
      settled.push(h);
      return h;
    },
    sendTransaction: async () => keccak256(toHex("send")),
    waitForTransactionReceipt: async () => ({ status: "success" }),
  } as never);
  const f = new x402Facilitator();
  f.register(NETWORK, new ExactEvmScheme(signer));
  const local: FacilitatorClient = {
    verify: (p, r) => f.verify(p, r),
    settle: (p, r) => f.settle(p, r),
    getSupported: async () => f.getSupported() as never,
  };
  return { local, router: facilitatorRoutes(local), address: SELLER };
}

const goods = { pulse: async () => ({ block: "1" }), usdcFlows: async () => ({ transfers: 0 }) };
const buyerAccount = privateKeyToAccount(generatePrivateKey());
let base = "";
let close = () => {};

test.before(async () => {
  const { app } = makeApp(pretendFacilitator(), goods);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
test.after(() => close());

test("free routes answer without payment", async () => {
  const h = await fetch(`${base}/health`);
  assert.equal(h.status, 200);
  assert.equal((await h.json()).network, "eip155:688689");
  assert.equal((await (await fetch(`${base}/catalog`)).json()).items.length, 2);
});

test("paid routes answer 402 with a PAYMENT-REQUIRED header, at different prices, in Atlantic USDC", async () => {
  const prices: string[] = [];
  for (const path of ["/v1/pulse", "/v1/usdc-flows"]) {
    const r = await fetch(`${base}${path}`);
    assert.equal(r.status, 402);
    const req = decodePaymentRequiredHeader(r.headers.get("payment-required")!);
    const offer = req.accepts[0];
    assert.equal(offer.network, NETWORK);
    assert.equal(offer.asset.toLowerCase(), USDC.toLowerCase());
    assert.equal(offer.payTo, SELLER);
    assert.deepEqual(offer.extra, { name: "USDC", version: "2" });
    prices.push(offer.amount);
  }
  assert.deepEqual(prices, ["1000", "5000"]);
});

test("an honest payment gets 200, the data and a PAYMENT-RESPONSE with the tx", async () => {
  const p = await buy(`${base}/v1/usdc-flows`, { account: buyerAccount, capAtomic: 10_000n, checkChain: false });
  assert.equal(p.status, 200, p.steps.map((s) => s.say).join(" | "));
  assert.deepEqual(p.body, { transfers: 0 });
  assert.equal(p.tx, settled.at(-1));
});

test("one unit short is refused with another 402", async () => {
  const before = settled.length;
  const p = await buy(`${base}/v1/pulse`, { account: buyerAccount, capAtomic: 10_000n, mode: "underpay", checkChain: false });
  assert.equal(p.status, 402);
  assert.equal(settled.length, before, "nothing was settled");
});

test("a broken signature is refused with another 402", async () => {
  const before = settled.length;
  const p = await buy(`${base}/v1/pulse`, { account: buyerAccount, capAtomic: 10_000n, mode: "forged", checkChain: false });
  assert.equal(p.status, 402);
  assert.match(p.steps.at(-1)!.say, /refused/);
  assert.equal(settled.length, before);
});

test("the buyer's own cap stops it signing a price above it", async () => {
  await assert.rejects(buy(`${base}/v1/usdc-flows`, { account: buyerAccount, capAtomic: 4_999n, checkChain: false }));
});

test("the facilitator answers /supported over HTTP", async () => {
  const s = await (await fetch(`${base}/facilitator/supported`)).json();
  assert.ok(JSON.stringify(s).includes(NETWORK));
});
