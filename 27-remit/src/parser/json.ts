import type { RawInvoice, InvoiceItem } from "../types.js";

/** Parses structured JSON / E-Invoice payloads. */
export function parseJsonInvoice(content: string): RawInvoice {
  let data: Record<string, any>;
  try {
    data = JSON.parse(content);
  } catch (err: any) {
    throw new Error(`Invalid JSON format: ${err.message}`);
  }

  // Reference extraction (standard aliases)
  const reference =
    data.reference ??
    data.invoiceNumber ??
    data.invoice_number ??
    data.invoiceId ??
    data.invoice_id ??
    data.number ??
    data.ref ??
    data.id;

  // Payee extraction
  const payee =
    data.payee ??
    data.recipient ??
    data.wallet ??
    data.address ??
    data.to ??
    (data.paymentDetails?.address || data.paymentDetails?.payee);

  // Currency / Token
  const currency =
    data.currency ??
    data.token ??
    data.asset ??
    data.denom ??
    (data.paymentDetails?.token || data.paymentDetails?.currency);

  // Amount / Total
  const amount =
    data.amount ??
    data.total ??
    data.totalAmount ??
    data.total_amount ??
    data.dueAmount ??
    data.balanceDue;

  // Line items
  const rawItems = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.lineItems)
      ? data.lineItems
      : Array.isArray(data.lines)
        ? data.lines
        : undefined;

  const items: InvoiceItem[] | undefined = rawItems?.map((it: any) => ({
    description: String(it.description ?? it.name ?? it.title ?? "Item"),
    quantity: it.quantity != null ? Number(it.quantity) : undefined,
    unitPrice: it.unitPrice != null ? Number(it.unitPrice) : it.price != null ? Number(it.price) : undefined,
    amount: Number(it.amount ?? (Number(it.quantity || 1) * Number(it.unitPrice || it.price || 0))),
  }));

  return {
    format: "json",
    rawText: content,
    reference: reference != null ? String(reference).trim() : undefined,
    payee: payee != null ? String(payee).trim() : undefined,
    currency: currency != null ? String(currency).trim() : undefined,
    amount: amount != null ? (typeof amount === "number" ? amount : String(amount).trim()) : undefined,
    dueDate: data.dueDate ?? data.due_date ?? data.due,
    issueDate: data.issueDate ?? data.issue_date ?? data.date,
    subtotal: data.subtotal != null ? Number(data.subtotal) : undefined,
    tax: data.tax != null ? Number(data.tax) : undefined,
    discount: data.discount != null ? Number(data.discount) : undefined,
    notes: data.notes ?? data.memo ?? data.description,
    items,
  };
}
