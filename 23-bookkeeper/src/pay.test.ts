import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, parseTransaction, recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { USDC, USDC_ABI } from "./chain.js";
import { FakeChain } from "./fake.js";
import { AUTH_TYPES, USDC_DOMAIN, buildProsPayment, buildUsdcPayment, paymentNonce } from "./pay.js";

const agent = privateKeyToAccount(("0x" + "ab".repeat(32)) as `0x${string}`);
const PETE = "0x1111111111111111111111111111111111111111" as const;

test("the nonce is the same for the same payment and different for any other", () => {
  const n = paymentNonce(agent.address, "payroll", 3, 0);
  assert.equal(n, paymentNonce(agent.address, "payroll", 3, 0));
  assert.notEqual(n, paymentNonce(agent.address, "payroll", 4, 0));
  assert.notEqual(n, paymentNonce(agent.address, "payroll", 3, 1));
  assert.notEqual(n, paymentNonce(agent.address, "rent", 3, 0));
  assert.notEqual(n, paymentNonce(PETE, "payroll", 3, 0));
});

test("the USDC payment is a transferWithAuthorization signed for USDC v2 on chain 1672 with the period's window", async () => {
  const chain = new FakeChain();
  const nonce = paymentNonce(agent.address, "payroll", 0, 0);
  const p = await buildUsdcPayment(agent, chain, { to: PETE, value: 50_000_000n, validAfter: 999n, validBefore: 1604800n, nonce });
  const tx = parseTransaction(p.raw);
  assert.equal(tx.to?.toLowerCase(), USDC.toLowerCase());
  assert.equal(tx.chainId, 1672);
  assert.equal(p.gas, 96_000n); // 80k estimate + a fifth
  const { functionName, args } = decodeFunctionData({ abi: USDC_ABI, data: tx.data! });
  assert.equal(functionName, "transferWithAuthorization");
  const [from, to, value, after, before, n, v, r, s] = args as readonly [string, string, bigint, bigint, bigint, string, number, `0x${string}`, `0x${string}`];
  assert.equal(from, agent.address);
  assert.equal(to, PETE);
  assert.equal(value, 50_000_000n);
  assert.equal(after, 999n);
  assert.equal(before, 1604800n);
  assert.equal(n, nonce);
  assert.equal(USDC_DOMAIN.name, "USDC");
  assert.equal(USDC_DOMAIN.version, "2");
  const signer = await recoverTypedDataAddress({ domain: USDC_DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { from: agent.address, to: PETE, value, validAfter: after, validBefore: before, nonce }, signature: { r, s, v: BigInt(v) } });
  assert.equal(signer, agent.address);
});

test("on the fake chain the same payment goes through once and is refused the second time", async () => {
  const chain = new FakeChain();
  chain.time = 1000n;
  chain.setUsdc(agent.address, 100_000_000n);
  const nonce = paymentNonce(agent.address, "payroll", 0, 0);
  const one = await buildUsdcPayment(agent, chain, { to: PETE, value: 50_000_000n, validAfter: 999n, validBefore: 2000n, nonce });
  await chain.sendRaw(one.raw);
  assert.equal((await chain.receipt(one.hash))?.status, "success");
  const two = await buildUsdcPayment(agent, chain, { to: PETE, value: 50_000_000n, validAfter: 999n, validBefore: 2000n, nonce });
  assert.notEqual(two.hash, one.hash);
  await chain.sendRaw(two.raw);
  assert.equal((await chain.receipt(two.hash))?.status, "reverted");
  assert.equal(await chain.usdcBalance(PETE), 50_000_000n);
});

test("PROS is a plain value transfer", async () => {
  const chain = new FakeChain();
  const p = await buildProsPayment(agent, chain, { to: PETE, value: 10n ** 16n });
  const tx = parseTransaction(p.raw);
  assert.equal(tx.to, PETE);
  assert.equal(tx.value, 10n ** 16n);
  assert.equal(tx.data, undefined);
});
