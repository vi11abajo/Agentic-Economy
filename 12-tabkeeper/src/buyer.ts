// One purchase: ask the endpoint, read its price from the 402, check it against the task's per-call cap and what
// is left of its budget, sign a USDC transfer authorization only if both pass, and send it. Retries always resend
// the SAME signed payment (same nonce), never a new one, so a lost answer can't turn into a second charge: the
// USDC contract takes a nonce once, the seller replays its answer for a nonce it already settled, and the
// ledger counts by nonce. Whether a payment went through is decided by the chain, not by the HTTP answer.
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { allow, payments, tasks, usdc, type Payment, type Row, type TaskState } from "./ledger.js";
import { NETWORK, USDC } from "./pharos.js";

export interface Chain {
  /** authorizationState(from, nonce) on the USDC contract: true once the payment is on chain. */
  used(from: string, nonce: string): Promise<boolean>;
  /** The transaction that used this authorization (the AuthorizationUsed event), searched from `fromBlock`. */
  findTx(from: string, nonce: string, fromBlock: bigint): Promise<string | undefined>;
  head(): Promise<bigint>;
}

export interface Deps {
  fetch: typeof fetch;
  chain: Chain;
  /** Signs an x402 payment for exactly these requirements. */
  sign(required: PaymentRequired, req: PaymentRequirements): Promise<PaymentPayload>;
  rows(): Row[];
  append(row: Row): void;
  now(): number;
  sleep(ms: number): Promise<void>;
  maxAttempts: number;
  timeoutMs: number;
}

export type BuyResult =
  | { kind: "free"; status: number; body: string }
  | { kind: "refused"; price: bigint; why: string }
  | { kind: "bought"; price: bigint; tx: string; total: bigint; body: string; replayed: boolean; attempts: number }
  | { kind: "failed"; why: string; price?: bigint; nonce?: string; paid: boolean; tx?: string; total: bigint };

const stamp = (d: Deps) => new Date(d.now()).toISOString();
const GRACE_S = 30n; // after validBefore, give a late settlement this long to show up before releasing the hold

export class PayError extends Error {}

/** The Pharos USDC option among what the 402 accepts. */
export function pick(required: PaymentRequired): PaymentRequirements | undefined {
  return required.accepts.find((a) => a.scheme === "exact" && a.network === NETWORK && a.asset.toLowerCase() === USDC.toLowerCase() && /^\d+$/.test(a.amount));
}

export async function probe(d: Pick<Deps, "fetch" | "timeoutMs">, url: string): Promise<{ status: number; required?: PaymentRequired; body: string }> {
  const res = await d.fetch(url, { signal: AbortSignal.timeout(d.timeoutMs) });
  const body = await res.text();
  if (res.status !== 402) return { status: res.status, body };
  const h = res.headers.get("payment-required");
  if (h) return { status: 402, required: decodePaymentRequiredHeader(h), body };
  try {
    return { status: 402, required: JSON.parse(body) as PaymentRequired, body };
  } catch {
    throw new PayError(`${url} answered 402 without payment requirements`);
  }
}

/**
 * Settle every payment still in flight against the chain: seen on chain -> paid (once), expired and not on chain
 * -> released. Nothing is ever paid twice and nothing held is released while it could still go through.
 */
export async function reconcile(d: Deps, only?: string): Promise<Payment[]> {
  const changed: Payment[] = [];
  const nowS = BigInt(Math.floor(d.now() / 1000));
  for (const p of payments(d.rows()).values()) {
    if (p.state !== "open" || (only && p.nonce !== only)) continue;
    if (await d.chain.used(p.from, p.nonce)) {
      const tx = (await d.chain.findTx(p.from, p.nonce, p.block)) ?? "unknown";
      d.append({ event: "paid", at: stamp(d), task: p.task, nonce: p.nonce, tx, price: p.price.toString() });
      changed.push({ ...p, state: "paid", tx });
    } else if (nowS > p.validBefore + GRACE_S) {
      d.append({ event: "released", at: stamp(d), task: p.task, nonce: p.nonce, why: "authorization expired and was never used on chain" });
      changed.push({ ...p, state: "released" });
    }
  }
  return changed;
}

const total = (d: Deps, task: string) => [...payments(d.rows()).values()].filter((p) => p.task === task && p.state === "paid").reduce((a, p) => a + p.price, 0n);

/** Sends a signed payment (again). Every attempt carries the same header. */
async function deliver(d: Deps, p: Payment): Promise<BuyResult> {
  let last = "";
  for (let n = 1; n <= d.maxAttempts; n++) {
    let res: Response | undefined;
    try {
      res = await d.fetch(p.url, { headers: { "PAYMENT-SIGNATURE": p.header }, signal: AbortSignal.timeout(d.timeoutMs) });
    } catch (e) {
      last = `no answer (${(e as Error).name === "TimeoutError" ? `timed out after ${d.timeoutMs / 1000}s` : (e as Error).message})`;
    }
    if (res) {
      const body = await res.text();
      const settled = res.headers.get("payment-response");
      if (res.status === 200 && settled) {
        const s = decodePaymentResponseHeader(settled);
        if (s.success && s.transaction) {
          const replayed = res.headers.get("x-replayed") === "true";
          d.append({ event: "attempt", at: stamp(d), nonce: p.nonce, n, result: `200, settled in ${s.transaction}${replayed ? " (seller replayed its answer for this payment)" : ""}` });
          if (payments(d.rows()).get(p.nonce)?.state !== "paid") d.append({ event: "paid", at: stamp(d), task: p.task, nonce: p.nonce, tx: s.transaction, price: p.price.toString(), replayed });
          return { kind: "bought", price: p.price, tx: s.transaction, total: total(d, p.task), body, replayed, attempts: n };
        }
        last = `200 but the settlement says ${s.errorReason ?? "failure"}`;
      } else if (res.status === 402) {
        let reason = "payment not accepted";
        try {
          const r = decodePaymentRequiredHeader(res.headers.get("payment-required") ?? "");
          reason = r.error ?? reason;
        } catch {
          /* body only */
        }
        last = `402: ${reason}`;
        d.append({ event: "attempt", at: stamp(d), nonce: p.nonce, n, result: last });
        // Rejected outright (bad signature, not enough USDC, expired...): resending the same thing won't help.
        if (!/settle|timeout|network|rpc|nonce too low|replacement/i.test(reason)) break;
        await d.sleep(1000 * n);
        continue;
      } else if (res.status < 500) {
        last = `HTTP ${res.status}: ${body.slice(0, 160)}`;
        d.append({ event: "attempt", at: stamp(d), nonce: p.nonce, n, result: last });
        break;
      } else last = `HTTP ${res.status}: ${body.slice(0, 160)}`;
    }
    d.append({ event: "attempt", at: stamp(d), nonce: p.nonce, n, result: last });
    if (n < d.maxAttempts) await d.sleep(1000 * 2 ** (n - 1));
  }
  // No usable answer. The chain says whether money moved; if it did, it counts once and a later retry of the
  // same payment gets the data from the seller's replay.
  await reconcile(d, p.nonce);
  const now = payments(d.rows()).get(p.nonce)!;
  return {
    kind: "failed",
    why: now.state === "paid" ? `${last}; the payment did go through on chain (${now.tx}), so it is counted once: run retry to get the data` : `${last}; not on chain, the ${usdc(p.price)} USDC stays held until the authorization expires`,
    price: p.price,
    nonce: p.nonce,
    paid: now.state === "paid",
    tx: now.tx,
    total: total(d, p.task),
  };
}

export async function buy(d: Deps, task: TaskState, url: string, o: { item?: string; maxPrice?: bigint } = {}): Promise<BuyResult> {
  await reconcile(d);
  const first = await probe(d, url);
  if (first.status !== 402) return { kind: "free", status: first.status, body: first.body };
  const required = first.required!;
  const req = pick(required);
  if (!req) {
    const why = `no Pharos USDC option among what it accepts (${required.accepts.map((a) => `${a.network} ${a.asset}`).join(", ")})`;
    d.append({ event: "refused", at: stamp(d), task: task.id, url, price: "0", why });
    return { kind: "refused", price: 0n, why };
  }
  const price = BigInt(req.amount);
  const fresh = tasks(d.rows()).get(task.id) ?? task;
  const ok = allow(fresh, price, o.maxPrice);
  if (!ok.ok) {
    d.append({ event: "refused", at: stamp(d), task: task.id, url, price: price.toString(), why: ok.why });
    return { kind: "refused", price, why: ok.why };
  }
  const payload = await d.sign({ ...required, accepts: [req] }, req);
  const auth = (payload.payload as { authorization: { from: string; to: string; nonce: string; validBefore: string; value: string } }).authorization;
  if (BigInt(auth.value) !== price) throw new PayError(`signed ${auth.value} but the price is ${price}`);
  const item = o.item || required.resource?.description || url;
  // Written before it is sent: if this process dies mid-request, the next run still knows the payment exists.
  d.append({ event: "signed", at: stamp(d), task: task.id, url, item, price: price.toString(), from: auth.from, to: auth.to, nonce: auth.nonce, validBefore: auth.validBefore, block: (await d.chain.head()).toString(), header: encodePaymentSignatureHeader(payload) });
  return deliver(d, payments(d.rows()).get(auth.nonce)!);
}

/** Resend a payment that is in flight or was paid without its data reaching us: same nonce, no new charge. */
/** A payment by its nonce or by the tx hash it settled in. */
export function findPayment(rows: Row[], id: string) {
  const all = payments(rows), key = id.toLowerCase();
  return all.get(id) ?? [...all.values()].find((p) => p.nonce.toLowerCase() === key || p.tx?.toLowerCase() === key);
}

export async function retry(d: Deps, id: string): Promise<BuyResult> {
  const p = findPayment(d.rows(), id);
  if (!p) throw new PayError(`no payment with nonce or tx ${id}`);
  const nonce = p.nonce;
  if (p.state === "released") throw new PayError("that payment expired unused; buy again for a fresh one");
  if (p.state === "open" && BigInt(Math.floor(d.now() / 1000)) > p.validBefore) {
    await reconcile(d, nonce);
    const again = payments(d.rows()).get(nonce)!;
    if (again.state !== "paid") throw new PayError("that payment's authorization has expired; it can't be used any more");
  }
  return deliver(d, payments(d.rows()).get(nonce)!);
}
