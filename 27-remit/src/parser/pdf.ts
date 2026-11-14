import { inflateSync } from "node:zlib";
import type { RawInvoice } from "../types.js";
import { parseTextInvoice } from "./text.js";

/** PDF string escapes: \( \) \\ \n and octal \ddd. Billing tools use them for parentheses in item names. */
function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, e: string) => {
    if (/^[0-7]+$/.test(e)) return String.fromCharCode(parseInt(e, 8));
    return ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" } as Record<string, string>)[e] ?? e;
  });
}

/**
 * Pulls the text out of a PDF with nothing but zlib: walk the content streams, inflate the compressed ones, collect
 * what the Tj / TJ operators draw, one line per text-showing operator. Good enough for invoices exported by billing
 * tools. A scanned PDF (just a picture) comes back empty and gets reported as unreadable, never guessed at.
 */
export function extractTextFromPdfBuffer(buffer: Buffer): string {
  const binary = buffer.toString("latin1");
  const lines: string[] = [];
  const streams = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  for (let m = streams.exec(binary); m; m = streams.exec(binary)) {
    let body = Buffer.from(m[1], "latin1");
    try {
      body = inflateSync(body);
    } catch {
      // not FlateDecode, read it as is
    }
    const ops = body.toString("latin1");
    const shows = /\(((?:\\.|[^\\)])*)\)\s*Tj|\[((?:\\.|[^\]])*)\]\s*TJ/g;
    for (let s = shows.exec(ops); s; s = shows.exec(ops)) {
      if (s[1] !== undefined) lines.push(unescapePdf(s[1]));
      else lines.push((s[2].match(/\((?:\\.|[^\\)])*\)/g) || []).map((p) => unescapePdf(p.slice(1, -1))).join(""));
    }
  }
  return lines.join("\n");
}

export function parsePdfInvoice(buffer: Buffer): RawInvoice {
  const text = extractTextFromPdfBuffer(buffer);
  if (!text.trim()) return { format: "pdf", problem: "the PDF has no text layer (a scan?) and remit doesn't OCR" };
  return { ...parseTextInvoice(text), format: "pdf", rawText: text };
}
