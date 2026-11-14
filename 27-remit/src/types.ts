import type { Hex } from "viem";

export type InvoiceFormat = "json" | "text" | "pdf" | "qr";

export interface InvoiceItem {
  description: string;
  quantity?: number;
  unitPrice?: number;
  amount: number;
}

/** Whatever a parser could lift off the page. Every field is optional on purpose: absent means absent. */
export interface RawInvoice {
  format: InvoiceFormat;
  rawText?: string;
  payee?: string;
  amount?: number | string;
  currency?: string;
  reference?: string;
  dueDate?: string;
  issueDate?: string;
  items?: InvoiceItem[];
  subtotal?: number;
  tax?: number;
  discount?: number;
  notes?: string;
  /** Only payment links carry this (EIP-681 `@chainId`). */
  chainId?: number;
  /** Set by a parser that couldn't read the document at all (no QR code, not a payment link, empty PDF). */
  problem?: string;
}

export interface ValidatedInvoice {
  format: InvoiceFormat;
  payee: Hex;
  amount: string;
  amountRaw: bigint;
  token: TokenInfo;
  reference: string;
  dueDate?: string;
  items?: InvoiceItem[];
  subtotal?: number;
  tax?: number;
}

export interface TokenInfo {
  symbol: string;
  name: string;
  address?: Hex;
  decimals: number;
  isNative: boolean;
}

export type FlagSeverity = "FATAL" | "WARNING" | "INFO";

export type FlagCode =
  | "MISSING_FIELD"
  | "MATH_MISMATCH"
  | "AMBIGUOUS_CURRENCY"
  | "UNSUPPORTED_TOKEN"
  | "INVALID_PAYEE"
  | "DANGEROUS_PAYEE"
  | "WRONG_CHAIN"
  | "EXPIRED_INVOICE"
  | "UNREADABLE"
  // the ones below need the chain
  | "TOKEN_NOT_ON_CHAIN"
  | "PAYEE_IS_CONTRACT"
  | "NOT_ENOUGH_FUNDS"
  | "WOULD_REVERT"
  | "ALREADY_PAID"
  | "CHAIN_UNREACHABLE";

export interface ValidationFlag {
  code: FlagCode;
  field?: string;
  message: string;
  severity: FlagSeverity;
  /** A tx or address on pharosscan that backs the flag up, when there is one. */
  proof?: string;
}

export interface ValidationResult {
  ok: boolean;
  invoice?: ValidatedInvoice;
  flags: ValidationFlag[];
}

export interface UnsignedTransaction {
  to: Hex;
  value: Hex;
  data: Hex;
  chainId: number;
  gasLimit?: Hex;
}

/** What the chain said about this payment when the plan was made. */
export interface ChainCheck {
  block: string;
  checkedAt: string;
  from?: Hex;
  /** what `from` holds of the invoice token, in token units */
  payerHolds?: string;
  gasEstimate?: string;
  gasPriceGwei?: string;
  feePros?: string;
}

export interface PaymentPlan {
  kind: "remit-plan";
  version: "2";
  createdAt: string;
  /** The invoice file the plan was made from; `sign` rebuilds from it right before the wallet sees anything. */
  source?: string;
  invoice: {
    format: InvoiceFormat;
    reference: string;
    payee: Hex;
    amount: string;
    amountRaw: string;
    token: { symbol: string; decimals: number; address?: Hex; isNative: boolean };
    dueDate?: string;
  };
  summary: {
    lineItemsCount: number;
    subtotal?: number;
    tax?: number;
    total: string;
    memo: string;
    calldataEncoding: string;
  };
  tx: UnsignedTransaction;
  chain?: ChainCheck;
  flags: ValidationFlag[];
}
