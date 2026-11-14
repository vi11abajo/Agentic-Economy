import type { RawInvoice, InvoiceItem } from "../types.js";

const STOP_WORDS_REF = new Set(["REFERENCE", "NUMBER", "AND", "IS", "ARE", "THE", "DATE", "TO", "FOR"]);

/** Parses plain text and Markdown formatted invoices. */
export function parseTextInvoice(text: string): RawInvoice {
  const lines = text.split(/\r?\n/).map((l) => l.trim());

  let reference: string | undefined;
  let payee: string | undefined;
  let currency: string | undefined;
  let amount: string | number | undefined;
  let dueDate: string | undefined;
  let issueDate: string | undefined;
  let subtotal: number | undefined;
  let tax: number | undefined;
  const items: InvoiceItem[] = [];

  // Refined Patterns
  // Require colon or hash or explicit "#INV-"
  const refRegex = /(?:invoice\s*(?:#|no\.?|num(?:ber)?)|ref(?:erence)?|memo)\s*[:#]\s*([A-Za-z0-9_-]+)/i;
  const payeeRegex = /(?:pay\s*(?:to|ee)?|recipient|wallet|address)\s*[:#]\s*(?:(?:\(Pharos\))[:\s]*)?([A-Za-z0-9xX]+)/i;
  const directAddressRegex = /\b(0x[a-fA-F0-9]{40})\b/;
  const dueDateRegex = /(?:due\s*date|payment\s*due|due)\s*[:#]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}\/[0-9]{2}\/[0-9]{4})/i;
  const issueDateRegex = /(?:issue\s*date|date)\s*[:#]\s*([0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{2}\/[0-9]{2}\/[0-9]{4})/i;

  const totalRegex = /(?:total(?:\s*due)?|amount(?:\s*due)?|balance\s*due)\s*[:#]\s*(?:\$|€|£)?\s*([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z$]+)?/i;
  const subtotalRegex = /subtotal\s*[:#]\s*(?:\$|€|£)?\s*([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z$]+)?/i;
  const taxRegex = /tax\s*[:#]\s*(?:\$|€|£)?\s*([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z$]+)?/i;

  const naturalLanguageRegex = /pay\s+([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z$]+)?\s+to\s+(0x[a-fA-F0-9]{40})/i;

  for (const line of lines) {
    if (!line) continue;

    // Check natural language single sentence
    const nlMatch = line.match(naturalLanguageRegex);
    if (nlMatch) {
      if (!amount) amount = nlMatch[1].replace(/,/g, "");
      if (!currency && nlMatch[2]) currency = nlMatch[2];
      if (!payee) payee = nlMatch[3];
    }

    // Reference
    if (!reference) {
      const m = line.match(refRegex);
      if (m && !STOP_WORDS_REF.has(m[1].toUpperCase())) {
        reference = m[1];
      }
    }

    // Payee
    if (!payee) {
      const m = line.match(payeeRegex);
      if (m) {
        payee = m[1];
      } else {
        const direct = line.match(directAddressRegex);
        if (direct && (line.toLowerCase().includes("pay") || line.toLowerCase().includes("to"))) {
          payee = direct[1];
        }
      }
    }

    // Due Date
    if (!dueDate) {
      const m = line.match(dueDateRegex);
      if (m) dueDate = m[1];
    }

    // Issue Date
    if (!issueDate) {
      const m = line.match(issueDateRegex);
      if (m) issueDate = m[1];
    }

    // Subtotal
    if (subtotal == null) {
      const m = line.match(subtotalRegex);
      if (m) {
        subtotal = parseFloat(m[1].replace(/,/g, ""));
        if (!currency && m[2]) currency = m[2];
      }
    }

    // Tax
    if (tax == null) {
      const m = line.match(taxRegex);
      if (m) tax = parseFloat(m[1].replace(/,/g, ""));
    }

    // Total / Amount
    if (!amount) {
      const m = line.match(totalRegex);
      if (m) {
        amount = m[1].replace(/,/g, "");
        if (!currency && m[2]) currency = m[2];
      }
    }

    // Markdown table row or line item
    if (line.includes("|") || /\s{2,}[0-9.,]+\s{2,}/.test(line)) {
      const parts = line.split("|").map((p) => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const lastPart = parts[parts.length - 1];
        const numMatch = lastPart.match(/([0-9,]+(?:\.[0-9]+)?)\s*([A-Za-z$]+)?/);
        if (numMatch && !lastPart.toLowerCase().includes("amount") && !lastPart.toLowerCase().includes("total")) {
          const itemAmt = parseFloat(numMatch[1].replace(/,/g, ""));
          if (!isNaN(itemAmt)) {
            items.push({
              description: parts[0],
              amount: itemAmt,
            });
            if (!currency && numMatch[2]) currency = numMatch[2];
          }
        }
      }
    }
  }

  // Fallback: If no reference found via "Reference:", check lines for "#INV-..."
  if (!reference) {
    for (const line of lines) {
      const hashMatch = line.match(/#(INV-[A-Za-z0-9_-]+)/i);
      if (hashMatch) {
        reference = hashMatch[1];
        break;
      }
    }
  }

  return {
    format: "text",
    rawText: text,
    reference,
    payee,
    currency,
    amount,
    dueDate,
    issueDate,
    subtotal,
    tax,
    items: items.length > 0 ? items : undefined,
  };
}
