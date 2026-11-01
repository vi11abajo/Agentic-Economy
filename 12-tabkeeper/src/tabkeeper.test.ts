import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import express from "express";
import { encodePaymentRequiredHeader, encodePaymentResponseHeader, encodePaymentSignatureHeader, decodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { buy, pick, reconcile, retry, type Chain, type Deps } from "./buyer.js";
import { allow, currentTask, parseUsdc, payments, tasks, usdc, type Row } from "./ledger.js";
import { NETWORK, USDC } from "./pharos.js";
import { paymentNonce, replayStore } from "./seller/replay.js";

const BUYER = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb";
const SELLER = "0xa991B44106b336B547259bD2B9b2f45931414348";
const T0 = Date.parse("2026-11-01T12:00:00Z");

function required(url: string, amount: string, over: Partial<PaymentRequirements> = {}): PaymentRequired {
  return {
    x402Version: 2,
    resource: { url, description: `data at ${url}`, mimeType: "application/json" },
    accepts: [{ scheme: "exact", network: NETWORK, asset: USDC, amount, payTo: SELLER, maxTimeoutSeconds: 120, extra: { name: "USDC", version: "2" }, ...over }],
  };
}

/**
 * A seller and a chain in memory, with the same rules as the real ones: a nonce is settled once, a settled
 * nonce sent again gets the kept answer, and `faults` can drop answers on the way back.
 */
function world(prices: Record<string, string>) {
  const used = new Map<string, string>(); // nonce -> tx
  const kept = new Map<string, string>(); // nonce -> body
  const faults: ("drop-after-settle" | "drop-before-settle" | "500")[] = [];
  let txs = 0;
  let signed = 0;
  let now = T0;
  const rows: Row[] = [];
  const answer = (status: number, body: string, headers: Record<string, string> = {}) => new Response(body, { status, headers });

  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const price = prices[url];
    if (!price) return answer(200, '{"free":true}');
    const sig = (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"];
    if (!sig) return answer(402, "{}", { "payment-required": encodePaymentRequiredHeader(required(url, price)) });
    const p = decodePaymentSignatureHeader(sig);
    const auth = (p.payload as { authorization: { nonce: string; value: string } }).authorization;
    if (auth.value !== price) return answer(402, "{}", { "payment-required": encodePaymentRequiredHeader({ ...required(url, price), error: "invalid_exact_evm_payload_authorization_value" }) });
    const fault = faults.shift();
    if (fault === "500") return answer(500, "upstream down");
    if (fault === "drop-before-settle") throw new TypeError("fetch failed");
    let replayed = false;
    if (!used.has(auth.nonce)) {
      used.set(auth.nonce, `0xtx${++txs}`);
      kept.set(auth.nonce, JSON.stringify({ bought: url }));
    } else replayed = true;
    if (fault === "drop-after-settle") throw new TypeError("fetch failed"); // settled, but the answer never arrives
    const headers: Record<string, string> = { "payment-response": encodePaymentResponseHeader({ success: true, transaction: used.get(auth.nonce)!, network: NETWORK, payer: BUYER }) };
    if (replayed) headers["x-replayed"] = "true";
    return answer(200, kept.get(auth.nonce)!, headers);
  }) as typeof fetch;

  const chain: Chain = {
    used: async (_from, nonce) => used.has(nonce),
    findTx: async (_from, nonce) => used.get(nonce),
    head: async () => 100n,
  };
  let n = 0;
  const deps: Deps = {
    fetch: fetchFn,
    chain,
    sign: async (req: PaymentRequired, r: PaymentRequirements): Promise<PaymentPayload> => {
      signed++;
      const nonce = `0x${(++n).toString(16).padStart(64, "0")}`;
      return { x402Version: 2, accepted: r, resource: req.resource, payload: { authorization: { from: BUYER, to: r.payTo, value: r.amount, validAfter: "0", validBefore: String(Math.floor(now / 1000) + r.maxTimeoutSeconds), nonce }, signature: "0xsig" } };
    },
    rows: () => rows,
    append: (r) => void rows.push(r),
    now: () => now,
    sleep: async () => {},
    maxAttempts: 3,
    timeoutMs: 1000,
  };
  const startTask = (budget: string, cap: string) => {
    rows.push({ event: "task", at: new Date(now).toISOString(), task: "t1", name: "test task", budget: parseUsdc(budget).toString(), cap: parseUsdc(cap).toString() });
    return currentTask(rows)!;
  };
  return { deps, rows, used, faults, startTask, signed: () => signed, advance: (s: number) => (now += s * 1000) };
}

const A = "https://seller.test/x402/harbor/yields";
const B = "https://seller.test/x402/pros/price";
const C = "https://seller.test/x402/harbor/positions/0x1";
const PRICES = { [A]: "2000", [B]: "1000", [C]: "10000" };

describe("ledger", () => {
  it("parses and prints USDC amounts exactly", () => {
    assert.equal(parseUsdc("0.002"), 2000n);
    assert.equal(parseUsdc("1"), 1_000_000n);
    assert.equal(usdc(2000n), "0.002");
    assert.equal(usdc(1_250_000n), "1.25");
    assert.throws(() => parseUsdc("0.0000001"));
  });

  it("refuses over the per-call cap and over what is left of the budget", () => {
    const t = { budget: 10_000n, cap: 5_000n, spent: 0n, held: 0n };
    assert.equal(allow(t, 2_000n).ok, true);
    const cap = allow(t, 10_000n);
    assert.equal(cap.ok, false);
    assert.match((cap as { why: string }).why, /over the per-call cap of 0.005/);
    const left = allow({ ...t, spent: 7_000n, held: 2_000n }, 2_000n);
    assert.equal(left.ok, false);
    assert.match((left as { why: string }).why, /^budget: 0.007 of 0.01 USDC spent and 0.002 held .* 0.001 left/);
    assert.equal(allow({ ...t, spent: 8_000n }, 2_000n).ok, true, "exactly the rest of the budget is allowed");
    assert.equal(allow(t, 3_000n, 2_000n).ok, false, "--max: what the data is worth to the task");
  });

  it("counts a payment once however many times it is reported paid", () => {
    const signed: Row = { event: "signed", at: "x", task: "t1", url: A, item: "a", price: "2000", from: BUYER, to: SELLER, nonce: "0x01", validBefore: "1", block: "1", header: "h" };
    const paid = (tx: string): Row => ({ event: "paid", at: "x", task: "t1", nonce: "0x01", tx, price: "2000" });
    const rows: Row[] = [{ event: "task", at: "x", task: "t1", name: "n", budget: "10000", cap: "5000" }, signed, signed, paid("0xa"), paid("0xb"), paid("0xa")];
    const t = tasks(rows).get("t1")!;
    assert.equal(t.spent, 2000n);
    assert.equal(t.payments.length, 1);
    assert.equal(payments(rows).get("0x01")!.tx, "0xa");
  });
});

describe("buying", () => {
  it("picks only exact USDC on Pharos mainnet", () => {
    assert.ok(pick(required(A, "1")));
    assert.equal(pick(required(A, "1", { network: "eip155:8453" })), undefined);
    assert.equal(pick(required(A, "1", { asset: "0x0000000000000000000000000000000000000001" })), undefined);
  });

  it("buys from two endpoints and keeps a running total with tx hashes", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.01", "0.005");
    const a = await buy(w.deps, t, A, { item: "Harbor yields" });
    const b = await buy(w.deps, t, B, { item: "PROS price" });
    assert.equal(a.kind, "bought");
    assert.equal(b.kind, "bought");
    if (a.kind !== "bought" || b.kind !== "bought") return;
    assert.equal(a.tx, "0xtx1");
    assert.equal(a.total, 2000n);
    assert.equal(b.total, 3000n);
    const paid = [...payments(w.rows).values()];
    assert.deepEqual(paid.map((p) => [p.item, usdc(p.price), p.tx]), [["Harbor yields", "0.002", "0xtx1"], ["PROS price", "0.001", "0xtx2"]]);
  });

  it("refuses an endpoint over the cap without signing anything", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.05", "0.005");
    const r = await buy(w.deps, t, C);
    assert.equal(r.kind, "refused");
    assert.equal(w.signed(), 0);
    assert.equal(w.rows.at(-1)!.event, "refused");
  });

  it("stops at the budget: the call that would go over is refused, nothing signed", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.003", "0.005");
    assert.equal((await buy(w.deps, t, A)).kind, "bought");
    assert.equal((await buy(w.deps, t, B)).kind, "bought");
    const third = await buy(w.deps, t, B);
    assert.equal(third.kind, "refused");
    assert.match((third as { why: string }).why, /^budget: 0.003 of 0.003 USDC spent/);
    assert.equal(w.signed(), 2);
    assert.equal(tasks(w.rows).get("t1")!.spent, 3000n);
  });

  it("a lost answer after settlement: the retry resends the same payment and it is counted once", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.01", "0.005");
    w.faults.push("drop-after-settle");
    const r = await buy(w.deps, t, A);
    assert.equal(r.kind, "bought");
    if (r.kind !== "bought") return;
    assert.equal(r.attempts, 2);
    assert.equal(r.replayed, true);
    assert.equal(w.signed(), 1, "one signature for the whole purchase");
    assert.equal(w.used.size, 1, "one settlement on chain");
    assert.equal(r.total, 2000n);
  });

  it("a 500 and a dropped request before settlement are retried with the same nonce", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.01", "0.005");
    w.faults.push("500", "drop-before-settle");
    const r = await buy(w.deps, t, B);
    assert.equal(r.kind, "bought");
    assert.equal(w.signed(), 1);
    const attempts = w.rows.filter((x) => x.event === "attempt");
    assert.equal(new Set(attempts.map((x) => (x as { nonce: string }).nonce)).size, 1);
    assert.equal(attempts.length, 3);
  });

  it("every send lost but the chain shows the payment: counted once, retry gets the data without a new charge", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.01", "0.005");
    w.faults.push("drop-after-settle", "drop-after-settle", "drop-after-settle");
    const r = await buy(w.deps, t, A);
    assert.equal(r.kind, "failed");
    if (r.kind !== "failed") return;
    assert.equal(r.paid, true);
    assert.equal(r.total, 2000n);
    const again = await retry(w.deps, r.nonce!);
    assert.equal(again.kind, "bought");
    assert.equal(w.signed(), 1);
    assert.equal(tasks(w.rows).get("t1")!.spent, 2000n);
    assert.equal(w.rows.filter((x) => x.event === "paid").length, 1);
  });

  it("a bought answer resent by its tx hash: same payment, same data, no new charge", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.01", "0.005");
    const r = await buy(w.deps, t, A);
    assert.equal(r.kind, "bought");
    if (r.kind !== "bought") return;
    const again = await retry(w.deps, r.tx.toUpperCase().replace("0X", "0x"));
    assert.equal(again.kind, "bought");
    if (again.kind !== "bought") return;
    assert.equal(again.tx, r.tx);
    assert.equal(w.signed(), 1);
    assert.equal(tasks(w.rows).get("t1")!.spent, 2000n);
    await assert.rejects(retry(w.deps, "0xdead"), /no payment with nonce or tx/);
  });

  it("never reached the seller: the money stays held, then is released once the authorization expires unused", async () => {
    const w = world(PRICES);
    const t = w.startTask("0.003", "0.005");
    w.faults.push("drop-before-settle", "drop-before-settle", "drop-before-settle");
    const r = await buy(w.deps, t, A);
    assert.equal(r.kind, "failed");
    assert.equal((r as { paid: boolean }).paid, false);
    assert.equal(tasks(w.rows).get("t1")!.held, 2000n);
    assert.equal((await buy(w.deps, t, A)).kind, "refused", "held money counts against the budget");
    w.advance(200);
    await reconcile(w.deps);
    const after = tasks(w.rows).get("t1")!;
    assert.equal(after.held, 0n);
    assert.equal(after.spent, 0n);
    assert.equal((await buy(w.deps, t, A)).kind, "bought");
  });

  it("a payment the seller rejects is not resent", async () => {
    const w = world({ [A]: "2000" });
    const t = w.startTask("0.01", "0.005");
    const bad: Deps = { ...w.deps, sign: async (req, r) => ({ ...(await w.deps.sign(req, r)), payload: { authorization: { from: BUYER, to: SELLER, value: "2000", validAfter: "0", validBefore: "9999999999", nonce: `0x${"ab".repeat(32)}` }, signature: "0x" } }) };
    // A seller that rejects every signature (verify fails).
    bad.fetch = (async (input: string | URL | Request, init?: RequestInit) =>
      (init?.headers as Record<string, string> | undefined)?.["PAYMENT-SIGNATURE"]
        ? new Response("{}", { status: 402, headers: { "payment-required": encodePaymentRequiredHeader({ ...required(String(input), "2000"), error: "invalid_exact_evm_payload_signature" }) } })
        : w.deps.fetch(input, init)) as typeof fetch;
    const r = await buy(bad, t, A);
    assert.equal(r.kind, "failed");
    assert.equal(w.rows.filter((x) => x.event === "attempt").length, 1);
  });
});

describe("seller replay", () => {
  const sig = (nonce: string) =>
    encodePaymentSignatureHeader({ x402Version: 2, accepted: required(A, "1").accepts[0], payload: { authorization: { from: BUYER, to: SELLER, value: "1", validAfter: "0", validBefore: "1", nonce }, signature: "0x" } });

  it("keys a payment by payer and nonce", () => {
    assert.equal(paymentNonce(sig("0xAB")), `${BUYER.toLowerCase()}:0xab`);
    assert.equal(paymentNonce("not base64 json"), undefined);
    assert.equal(paymentNonce(undefined), undefined);
  });

  it("answers the same payment sent twice with the first answer, settling once", async () => {
    let settles = 0;
    const app = express();
    const replay = replayStore();
    app.use(replay.middleware);
    app.get(["/a", "/b"], (_req, res) => {
      settles++;
      res.setHeader("payment-response", `settled-${settles}`);
      res.json({ n: settles });
    });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const h = { "PAYMENT-SIGNATURE": sig("0x01") };
      const [one, two] = await Promise.all([fetch(`${base}/a`, { headers: h }), fetch(`${base}/a`, { headers: h })]);
      const three = await fetch(`${base}/a`, { headers: h });
      assert.deepEqual([await one.json(), await two.json(), await three.json()], [{ n: 1 }, { n: 1 }, { n: 1 }]);
      assert.equal(three.headers.get("payment-response"), "settled-1");
      assert.equal(three.headers.get("x-replayed"), "true");
      assert.equal(settles, 1);
      const other = await fetch(`${base}/b`, { headers: h });
      assert.equal(other.status, 409, "one payment can't buy a second resource");
      const fresh = await fetch(`${base}/a`, { headers: { "PAYMENT-SIGNATURE": sig("0x02") } });
      assert.deepEqual(await fresh.json(), { n: 2 });
    } finally {
      server.close();
    }
  });
});
