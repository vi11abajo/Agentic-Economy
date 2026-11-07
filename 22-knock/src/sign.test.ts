import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { fakeChain, word } from "./fake.js";
import { buildPlan, type Plan } from "./plan.js";
import { USDC } from "./registry.js";
import { recheck, serveSigning, verifyHandoff } from "./sign.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const usdc = USDC.address as string;
const DEAD = "0x000000000000000000000000000000000000dEaD" as Hex;

async function setup() {
  const payer = privateKeyToAccount(generatePrivateKey()); // a throwaway key, only to make a test signature
  const ph = fakeChain({
    [usdc]: { code: "0x6080", answers: { "0x70a08231": { ok: true, data: word(500_000) }, "0x313ce567": { ok: true, data: word(6) }, "0x95d89b41": { ok: true, data: encodeAbiParameters([{ type: "string" }], ["USDC"]) } } },
    [payer.address.toLowerCase()]: { nonce: 5, balance: 10n ** 16n },
  });
  const built = await buildPlan(ph, fakeChain({}), { amount: "0.01", token: "USDC", recipient: DEAD, recipientKind: "address" }, payer.address);
  const plan = built.plan!;
  const td = plan.byAuthorization!.typedData as Parameters<typeof payer.signTypedData>[0];
  const { EIP712Domain: _drop, ...types } = (td as unknown as { types: Record<string, unknown> }).types;
  const signature = await payer.signTypedData({ ...(td as object), types } as Parameters<typeof payer.signTypedData>[0]);
  return { ph, plan, signature, payer };
}

test("a genuine signed authorization passes the payee's check", async () => {
  const { plan, signature } = await setup();
  assert.equal((await verifyHandoff({ kind: "knock-authorization", plan, signature })).ok, true);
});

test("a payer who edits the amount in the file is caught", async () => {
  const { plan, signature } = await setup();
  const edited: Plan = JSON.parse(JSON.stringify(plan));
  edited.amount = "100";
  edited.raw = "100000000";
  const v = await verifyHandoff({ kind: "knock-authorization", plan: edited, signature });
  assert.equal(v.ok, false);
});

test("a signed message whose value was changed after signing is caught", async () => {
  const { plan, signature } = await setup();
  const edited: Plan = JSON.parse(JSON.stringify(plan));
  (edited.byAuthorization!.typedData as { message: Record<string, string> }).message.value = "1";
  edited.amount = "0.000001";
  edited.raw = "1";
  assert.equal((await verifyHandoff({ kind: "knock-authorization", plan: edited, signature })).ok, false);
});

test("a plan file whose tx was tampered with is refused at the recheck", async () => {
  const { ph, plan, payer } = await setup();
  const edited: Plan = JSON.parse(JSON.stringify(plan));
  edited.tx.data = (edited.tx.data.slice(0, -4) + "ffff") as Hex;
  const v = await recheck(ph, fakeChain({}), edited, payer.address, "0x688", "transfer");
  assert.equal(v.ok, false);
  const good = await recheck(ph, fakeChain({}), plan, payer.address, "0x688", "transfer");
  assert.equal(good.ok, true);
  assert.equal(good.tx?.data, plan.tx.data);
});

test("another chain is refused", async () => {
  const { ph, plan, payer } = await setup();
  assert.equal((await recheck(ph, fakeChain({}), plan, payer.address, "0x1", "transfer")).ok, false);
});

test("the page tells whoever started it when the payment is mined, so --until-mined can stop it", async () => {
  const { plan } = await setup();
  const dir = mkdtempSync(join(tmpdir(), "knock-"));
  const file = join(dir, "plan.json");
  writeFileSync(file, JSON.stringify(plan));
  const ph = fakeChain({}, { receipt: async () => ({ status: "success", blockNumber: 22_400_001, gasUsed: 37_435n }) });
  const page = await serveSigning(file, 0, ph, fakeChain({}));
  try {
    const r = await fetch(`http://127.0.0.1:${page.port}/receipt`, { method: "POST", body: JSON.stringify({ hash: "0xabc", kind: "transfer" }) });
    assert.equal(r.status, 200);
    const line = await page.mined;
    assert.match(line, /success in block 22400001, gas used 37435/);
  } finally {
    await page.close();
  }
});
