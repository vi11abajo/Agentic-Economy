// The paying side, one visible step at a time: knock, read the price off the 402, sign a USDC authorization,
// knock again with it, read the receipt header, then go and look at Atlantic to see the money really moved.
// The buyer never sends a transaction and needs no PROS: the seller's facilitator submits the signature and pays gas.
import { parseEventLogs, type Account, type Hex } from "viem";
import { x402Client } from "@x402/core/client";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { EIP3009, NETWORK, USDC, reader, txUrl, usdc } from "./atlantic.js";

/** honest pays the asked price; underpay signs for one unit less; forged breaks the signature after signing. */
export type Mode = "honest" | "underpay" | "forged";

export interface Step {
  say: string;
  ok?: boolean;
}

export interface Purchase {
  steps: Step[];
  status: number;
  body?: unknown;
  tx?: Hex;
  settledOnChain?: boolean;
}

type Fetch = typeof fetch;

export function signerFor(account: Account, capAtomic: bigint) {
  // The SDK's own spend control is a second lock: it refuses to sign anything above the cap or in another asset.
  return new x402Client()
    .register(NETWORK, new ExactEvmScheme(account as never))
    .setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: capAtomic.toString() }] });
}

function readRequired(res: Response, body: string): PaymentRequired | undefined {
  const h = res.headers.get("payment-required");
  if (h) return decodePaymentRequiredHeader(h);
  try {
    return JSON.parse(body) as PaymentRequired;
  } catch {
    return undefined;
  }
}

export async function buy(
  url: string,
  o: { account: Account; capAtomic: bigint; mode?: Mode; fetchFn?: Fetch; checkChain?: boolean },
): Promise<Purchase> {
  const fetchFn = o.fetchFn ?? fetch;
  const steps: Step[] = [];
  const mode = o.mode ?? "honest";

  const first = await fetchFn(url);
  const firstBody = await first.text();
  if (first.status !== 402) {
    steps.push({ say: `GET ${url} -> ${first.status} without paying (free route)`, ok: first.ok });
    return { steps, status: first.status, body: safeJson(firstBody) };
  }
  const required = readRequired(first, firstBody);
  const offer = required?.accepts.find((a) => a.scheme === "exact" && a.network === NETWORK && a.asset.toLowerCase() === USDC.toLowerCase());
  if (!required || !offer) {
    steps.push({ say: `GET ${url} -> 402, but no offer in Atlantic test USDC I can pay`, ok: false });
    return { steps, status: 402 };
  }
  steps.push({ say: `GET ${url} -> 402 Payment Required: ${usdc(offer.amount)} USDC on ${offer.network} to ${offer.payTo}`, ok: true });

  const toSign: PaymentRequired = mode === "underpay" ? { ...required, accepts: [{ ...offer, amount: (BigInt(offer.amount) - 1n).toString() }] } : { ...required, accepts: [offer] };
  let payload: PaymentPayload = await signerFor(o.account, o.capAtomic).createPaymentPayload(toSign);
  const auth = (payload.payload as { authorization: { value: string; nonce: Hex; from: Hex } }).authorization;
  if (mode === "forged") {
    const sig = (payload.payload as { signature: Hex }).signature;
    const flipped = (sig.slice(0, -4) + (sig.slice(-4, -2) === "00" ? "01" : "00") + sig.slice(-2)) as Hex;
    payload = { ...payload, payload: { ...(payload.payload as object), signature: flipped } } as PaymentPayload;
  }
  steps.push({
    say:
      `signed an EIP-3009 authorization for ${usdc(auth.value)} USDC from ${auth.from}, nonce ${auth.nonce.slice(0, 10)}…` +
      (mode === "underpay" ? " (one unit less than asked, on purpose)" : mode === "forged" ? " and then broke one byte of the signature, on purpose" : ""),
    ok: true,
  });

  const second = await fetchFn(url, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
  const secondBody = await second.text();
  if (second.status === 402) {
    const again = readRequired(second, secondBody);
    steps.push({ say: `sent it -> 402 again, refused: ${again?.error ?? "no reason given"}`, ok: mode !== "honest" });
    return { steps, status: 402 };
  }
  const receipt = second.headers.get("payment-response");
  if (second.status !== 200 || !receipt) {
    steps.push({ say: `sent it -> HTTP ${second.status} ${secondBody.slice(0, 160)}`, ok: false });
    return { steps, status: second.status };
  }
  const settled = decodePaymentResponseHeader(receipt);
  const tx = settled.transaction as Hex;
  steps.push({ say: `sent it -> 200 OK, PAYMENT-RESPONSE: success=${settled.success} tx ${tx}`, ok: settled.success === true });
  steps.push({ say: txUrl(tx) });

  let settledOnChain: boolean | undefined;
  if (o.checkChain !== false) {
    const chain = reader();
    const r = await chain.getTransactionReceipt({ hash: tx }).catch(() => undefined);
    const events = r ? parseEventLogs({ abi: EIP3009, logs: r.logs }) : [];
    const used = events.some((e) => e.eventName === "AuthorizationUsed" && e.args.nonce === auth.nonce && e.args.authorizer.toLowerCase() === auth.from.toLowerCase());
    const moved = events.find((e) => e.eventName === "Transfer" && e.address.toLowerCase() === USDC.toLowerCase());
    settledOnChain = r?.status === "success" && used && !!moved;
    steps.push({
      say: r
        ? `on Atlantic: block ${r.blockNumber}, status ${r.status}, AuthorizationUsed for this nonce ${used ? "yes" : "NO"}, ${moved ? `Transfer ${usdc((moved.args as { value: bigint }).value)} USDC to ${(moved.args as { to: string }).to}` : "no USDC Transfer"}`
        : `on Atlantic: no receipt for ${tx}`,
      ok: settledOnChain,
    });
  }
  return { steps, status: 200, body: safeJson(secondBody), tx, settledOnChain };
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
