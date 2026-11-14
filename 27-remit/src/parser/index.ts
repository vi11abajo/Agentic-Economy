import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import type { RawInvoice } from "../types.js";
import { parseJsonInvoice } from "./json.js";
import { parseTextInvoice } from "./text.js";
import { parsePdfInvoice } from "./pdf.js";
import { parseQrInvoice, parsePaymentLink } from "./image.js";

export { parseJsonInvoice, parseTextInvoice, parsePdfInvoice, parseQrInvoice, parsePaymentLink };

/** Picks the reader by what the bytes look like first and the file name second (people rename things). */
export function parseInvoiceBytes(bytes: Buffer, name = ""): RawInvoice {
  const ext = extname(name).toLowerCase();
  if (bytes.subarray(0, 5).toString("latin1") === "%PDF-") return parsePdfInvoice(bytes);
  if (bytes.subarray(1, 4).toString("latin1") === "PNG") return parseQrInvoice(bytes);
  if ([".jpg", ".jpeg", ".webp", ".gif"].includes(ext))
    return { format: "qr", problem: `remit reads QR codes from PNG only; ${ext} isn't supported, take a PNG screenshot instead` };
  const text = bytes.toString("utf-8").replace(/^﻿/, "");
  if (text.trim().startsWith("{")) return parseJsonInvoice(text);
  if (/^ethereum:/i.test(text.trim())) return { format: "qr", ...parsePaymentLink(text.trim()) } as RawInvoice;
  return parseTextInvoice(text);
}

/** A path to a file, or the invoice text itself (handy when a user pastes a bill into the chat). */
export function parseInvoice(input: string): RawInvoice {
  if (existsSync(input)) return parseInvoiceBytes(readFileSync(input), input);
  return parseInvoiceBytes(Buffer.from(input, "utf-8"));
}
