// Seller-side idempotency: a paid response is kept under the payment's EIP-3009 nonce. If the buyer sends the
// same signed payment again (its first answer got lost on the way back), it gets that same answer and the same
// PAYMENT-RESPONSE, and nothing is settled twice. Two copies arriving at once share one settlement.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { NextFunction, Request, Response } from "express";
import { decodePaymentSignatureHeader } from "@x402/core/http";

export interface Kept {
  path: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  at: string;
}

/** The nonce of an EIP-3009 payment in a PAYMENT-SIGNATURE header, or undefined. */
export function paymentNonce(header: string | undefined): string | undefined {
  if (!header) return undefined;
  try {
    const p = decodePaymentSignatureHeader(header);
    const auth = (p.payload as { authorization?: { from?: string; nonce?: string } }).authorization;
    return auth?.nonce && auth.from ? `${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}` : undefined;
  } catch {
    return undefined;
  }
}

export function replayStore(file?: string, keep = 5000) {
  const kept = new Map<string, Kept>(file && existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as [string, Kept][]) : []);
  const inFlight = new Map<string, Promise<void>>();
  const save = () => {
    if (!file) return;
    while (kept.size > keep) kept.delete(kept.keys().next().value as string);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([...kept]));
  };
  const send = (res: Response, k: Kept) => {
    res.status(k.status);
    for (const [h, v] of Object.entries(k.headers)) res.setHeader(h, v);
    res.setHeader("X-Replayed", "true");
    res.end(k.body);
  };

  async function middleware(req: Request, res: Response, next: NextFunction) {
    const key = paymentNonce(req.header("payment-signature") ?? undefined);
    if (!key) return next();
    const wait = inFlight.get(key);
    if (wait) await wait;
    const hit = kept.get(key);
    if (hit) {
      if (hit.path !== req.path) return void res.status(409).json({ error: "this payment already bought another resource", bought: hit.path });
      return send(res, hit);
    }
    let done!: () => void;
    inFlight.set(key, new Promise<void>((r) => (done = r)));
    const chunks: Buffer[] = [];
    const write = res.write.bind(res) as (...a: unknown[]) => boolean;
    const end = res.end.bind(res) as (...a: unknown[]) => Response;
    res.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (chunk) chunks.push(Buffer.from(chunk as string));
      return write(chunk, ...rest);
    }) as never;
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk as string));
      const settled = res.getHeader("payment-response");
      if (res.statusCode === 200 && settled) {
        const headers: Record<string, string> = { "payment-response": String(settled) };
        const type = res.getHeader("content-type");
        if (type) headers["content-type"] = String(type);
        kept.set(key, { path: req.path, status: 200, headers, body: Buffer.concat(chunks).toString("utf8"), at: new Date().toISOString() });
        save();
      }
      inFlight.delete(key);
      done();
      return end(chunk, ...rest);
    }) as never;
    res.on("close", () => {
      if (inFlight.get(key)) {
        inFlight.delete(key);
        done();
      }
    });
    next();
  }

  return { middleware, size: () => kept.size };
}
