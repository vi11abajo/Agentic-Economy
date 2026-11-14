import { isAddress, getAddress, parseUnits, type Hex } from "viem";
import type { RawInvoice, ValidationResult, ValidationFlag, ValidatedInvoice } from "./types.js";
import { resolveToken, CANONICAL_TOKENS, PUBLIC_DEV_KEYS, PHAROS_CHAIN_ID } from "./tokens.js";

const CENT = 0.009; // invoices round to cents; anything bigger than that is a real disagreement

/**
 * The paper check. No chain here, only "does this invoice agree with itself and is it complete". Every problem
 * becomes a flag with the field it is about; we never fill a hole with a likely value. A FATAL flag means no plan.
 */
export function validateInvoice(raw: RawInvoice, options: { allowExpired?: boolean; now?: number } = {}): ValidationResult {
  const flags: ValidationFlag[] = [];
  const stop = (code: ValidationFlag["code"], field: string, message: string) => flags.push({ code, field, message, severity: "FATAL" });

  if (raw.problem) stop("UNREADABLE", "document", `Couldn't read this document: ${raw.problem}.`);

  const reference = raw.reference?.trim();
  if (!reference) stop("MISSING_FIELD", "reference", "No invoice number or reference. Without it the payment can't be matched to this invoice later.");

  if (raw.chainId !== undefined && raw.chainId !== PHAROS_CHAIN_ID)
    stop("WRONG_CHAIN", "chainId", `The payment link is for chain ${raw.chainId}, not Pharos (${PHAROS_CHAIN_ID}). Paying it here would send the money somewhere the payee may not control.`);

  let payee: Hex | undefined;
  const payeeText = raw.payee?.trim();
  if (!payeeText) {
    stop("MISSING_FIELD", "payee", "No payee address on the invoice.");
  } else if (!isAddress(payeeText, { strict: false })) {
    stop("INVALID_PAYEE", "payee", `'${payeeText}' is not an EVM address (needs 0x and 40 hex characters).`);
  } else if (/[a-f]/.test(payeeText) && /[A-F]/.test(payeeText) && !isAddress(payeeText)) {
    // Mixed case means someone meant a checksum. A failed checksum is how a one-character typo shows up.
    stop("INVALID_PAYEE", "payee", `'${payeeText}' has a broken checksum: at least one character was changed or mistyped.`);
  } else {
    payee = getAddress(payeeText);
    const lower = payee.toLowerCase();
    if (lower === "0x0000000000000000000000000000000000000000") stop("DANGEROUS_PAYEE", "payee", "The payee is the zero address; whatever goes there is gone.");
    for (const t of Object.values(CANONICAL_TOKENS))
      if (t.address && t.address.toLowerCase() === lower)
        stop("DANGEROUS_PAYEE", "payee", `The payee is the ${t.symbol} token contract itself. Tokens sent there are stuck for good.`);
    if (PUBLIC_DEV_KEYS.has(lower))
      stop("DANGEROUS_PAYEE", "payee", `${payee} is a default Hardhat/Anvil test account. Its private key is public, so anything paid to it gets swept by bots.`);
  }

  const lookup = resolveToken(raw.currency);
  if (lookup.error === "missing") stop("MISSING_FIELD", "currency", "The invoice doesn't say what to pay in.");
  else if (lookup.error === "ambiguous")
    stop("AMBIGUOUS_CURRENCY", "currency", `'${raw.currency}' doesn't name a token. On Pharos it could be USDC, PROS or something else entirely; ask the issuer which one.`);
  else if (lookup.error === "unsupported") stop("UNSUPPORTED_TOKEN", "currency", `'${raw.currency}' isn't one of the tokens remit pays in (PROS, WPROS, USDC).`);
  const token = lookup.token;

  let amountNumber = 0;
  let amountRaw = 0n;
  const amountText = raw.amount === undefined || raw.amount === null ? "" : String(raw.amount).replace(/,/g, "").trim();
  if (!amountText) {
    stop("MISSING_FIELD", "amount", "No total on the invoice.");
  } else if (!/^\d+(\.\d+)?$/.test(amountText) || Number(amountText) <= 0) {
    stop("MATH_MISMATCH", "amount", `The total '${raw.amount}' isn't a positive number.`);
  } else {
    amountNumber = Number(amountText);
    if (token) {
      const [, frac = ""] = amountText.split(".");
      if (frac.length > token.decimals) stop("MATH_MISMATCH", "amount", `${amountText} has more decimals than ${token.symbol} can hold (${token.decimals}).`);
      else amountRaw = parseUnits(amountText, token.decimals);
    }
  }

  // Line items: only checked when the invoice has them, and only against what the invoice itself states.
  if (raw.items?.length && amountNumber > 0) {
    const itemsSum = raw.items.reduce((sum, it) => sum + (it.amount || 0), 0);
    const subtotal = raw.subtotal ?? itemsSum;
    const computed = subtotal + (raw.tax || 0) - (raw.discount || 0);
    if (Math.abs(itemsSum - subtotal) > CENT)
      stop("MATH_MISMATCH", "items", `The line items add up to ${itemsSum.toFixed(2)} but the subtotal says ${subtotal.toFixed(2)}.`);
    if (Math.abs(computed - amountNumber) > CENT)
      stop("MATH_MISMATCH", "amount", `Subtotal ${subtotal.toFixed(2)} + tax ${(raw.tax || 0).toFixed(2)} - discount ${(raw.discount || 0).toFixed(2)} = ${computed.toFixed(2)}, but the total says ${amountNumber.toFixed(2)}.`);
  }

  if (raw.dueDate) {
    const due = Date.parse(raw.dueDate);
    if (Number.isNaN(due)) {
      flags.push({ code: "UNREADABLE", field: "dueDate", message: `Couldn't read the due date '${raw.dueDate}'.`, severity: "WARNING" });
    } else if (due + 24 * 3600 * 1000 < (options.now ?? Date.now())) {
      flags.push({
        code: "EXPIRED_INVOICE",
        field: "dueDate",
        message: `The due date ${raw.dueDate} has passed. Check with the issuer that it's still owed and the address still current.`,
        severity: options.allowExpired ? "WARNING" : "FATAL",
      });
    }
  }

  if (flags.some((f) => f.severity === "FATAL") || !payee || !token || !reference) return { ok: false, flags };

  const invoice: ValidatedInvoice = {
    format: raw.format,
    payee,
    amount: amountText,
    amountRaw,
    token,
    reference,
    dueDate: raw.dueDate,
    items: raw.items,
    subtotal: raw.subtotal,
    tax: raw.tax,
  };
  return { ok: true, invoice, flags };
}
