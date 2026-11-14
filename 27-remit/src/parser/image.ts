import { PNG } from "pngjs";
import jsQRModule from "jsqr";
import { formatUnits } from "viem";
import type { RawInvoice } from "../types.js";
import { CANONICAL_TOKENS, tokenByAddress } from "../tokens.js";
import { parseJsonInvoice } from "./json.js";

// jsqr ships CommonJS with a `default` in its typings; node and esbuild hand us the function itself.
type Scan = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQR: Scan = typeof jsQRModule === "function" ? (jsQRModule as unknown as Scan) : (jsQRModule as unknown as { default: Scan }).default;

/**
 * Payment requests that arrive as a picture: a QR code on a PNG (a screenshot of a checkout page, a printed bill).
 * We only read what the QR code says. There is no OCR here on purpose: text recognised off pixels is a guess, and a
 * guessed digit in an address or an amount is exactly what this tool exists to prevent.
 */
export function readQrFromPng(buffer: Buffer): string | undefined {
  const png = PNG.sync.read(buffer);
  const hit = jsQR(new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.length), png.width, png.height);
  return hit?.data;
}

/** "2.5e18" and "250000" both mean an exact integer in EIP-681; never let a float touch it. */
export function exactInteger(text: string): bigint | undefined {
  const m = text.trim().match(/^(\d+)(?:\.(\d+))?(?:e(\d+))?$/i);
  if (!m) return undefined;
  const [, whole, frac = "", exp = "0"] = m;
  const shift = Number(exp) - frac.length;
  if (shift < 0) return /^0*$/.test(frac.slice(frac.length + shift)) ? BigInt(whole + frac.slice(0, frac.length + shift)) : undefined;
  return BigInt(whole + frac + "0".repeat(shift));
}

/**
 * EIP-681 payment links: `ethereum:<payee>@1672?value=<wei>` for native coin, or
 * `ethereum:<token>@1672/transfer?address=<payee>&uint256=<units>` for a token. EIP-681 has no field for an invoice
 * number, so we read an extra `ref=` (or `memo=`) parameter; a link without one is flagged, not filled in.
 */
export function parsePaymentLink(link: string): Omit<RawInvoice, "format"> | undefined {
  const m = link.trim().match(/^ethereum:(?:pay-)?(0x[0-9a-fA-F]{40})(?:@(\d+))?(?:\/(\w+))?(?:\?(.*))?$/);
  if (!m) return undefined;
  const [, target, chain, fn, query = ""] = m;
  const params = new URLSearchParams(query);
  const out: Omit<RawInvoice, "format"> = {
    rawText: link,
    chainId: chain ? Number(chain) : undefined,
    reference: params.get("ref") ?? params.get("memo") ?? undefined,
  };

  if (!fn) {
    // plain coin payment: the target is the payee
    out.payee = target;
    out.currency = "PROS";
    const wei = params.get("value");
    const exact = wei === null ? undefined : exactInteger(wei);
    if (exact !== undefined) out.amount = formatUnits(exact, CANONICAL_TOKENS.PROS.decimals);
    else if (wei !== null) out.amount = wei; // the validator will reject it, with the text as written
    return out;
  }

  if (fn !== "transfer") return { ...out, problem: `link calls '${fn}', remit only pays plain transfers` };
  const token = tokenByAddress(target);
  out.currency = token ? token.symbol : target; // an unknown contract stays visible as an address
  const payee = params.get("address");
  if (payee) out.payee = payee; // checked (and checksum-checked) by the validator, like any other payee
  const units = params.get("uint256");
  const exact = units === null ? undefined : exactInteger(units);
  if (exact !== undefined && token) out.amount = formatUnits(exact, token.decimals);
  else if (units !== null && !token) out.amount = units;
  return out;
}

export function parseQrInvoice(buffer: Buffer): RawInvoice {
  let text: string | undefined;
  try {
    text = readQrFromPng(buffer);
  } catch (e) {
    return { format: "qr", problem: `not a PNG remit can read: ${(e as Error).message}` };
  }
  if (!text) return { format: "qr", problem: "no QR code found in the picture" };
  if (text.trim().startsWith("{")) return { ...parseJsonInvoice(text), format: "qr", rawText: text };
  const link = parsePaymentLink(text);
  if (!link) return { format: "qr", rawText: text, problem: "the QR code holds something that isn't a payment link" };
  return { format: "qr", ...link };
}
