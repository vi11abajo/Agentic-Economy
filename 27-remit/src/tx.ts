import { encodeFunctionData, stringToHex, concat, toHex, parseAbi, type Hex } from "viem";
import type { ValidatedInvoice, PaymentPlan, UnsignedTransaction, ValidationFlag, ChainCheck } from "./types.js";
import { PHAROS_CHAIN_ID } from "./tokens.js";

const TRANSFER = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

/** "INV:<reference>" as bytes. Short, readable on pharosscan's input view, and greppable later. */
export function encodeReferenceMemo(reference: string): Hex {
  return stringToHex(`INV:${reference}`);
}

/**
 * Where the reference goes:
 * - PROS: a plain value transfer to a wallet ignores calldata, so the memo IS the data.
 * - USDC / WPROS: transfer(to, amount) followed by the memo bytes. Solidity decodes the two arguments and never
 *   looks past them, so the call is unchanged and the reference sits in the tx input for good.
 */
export function buildUnsignedTransaction(invoice: ValidatedInvoice): { tx: UnsignedTransaction; calldataEncoding: string } {
  const memo = encodeReferenceMemo(invoice.reference);
  if (invoice.token.isNative) {
    return {
      tx: { to: invoice.payee, value: toHex(invoice.amountRaw), data: memo, chainId: PHAROS_CHAIN_ID },
      calldataEncoding: "native transfer, reference as the whole input",
    };
  }
  const call = encodeFunctionData({ abi: TRANSFER, functionName: "transfer", args: [invoice.payee, invoice.amountRaw] });
  return {
    tx: { to: invoice.token.address!, value: "0x0", data: concat([call, memo]), chainId: PHAROS_CHAIN_ID },
    calldataEncoding: "transfer(to, amount) + reference bytes after the arguments",
  };
}

export function createPaymentPlan(
  invoice: ValidatedInvoice,
  flags: ValidationFlag[] = [],
  extra: { chain?: ChainCheck; gasLimit?: Hex; source?: string } = {},
): PaymentPlan {
  const { tx, calldataEncoding } = buildUnsignedTransaction(invoice);
  if (extra.gasLimit) tx.gasLimit = extra.gasLimit;
  return {
    kind: "remit-plan",
    version: "2",
    createdAt: new Date().toISOString(),
    ...(extra.source ? { source: extra.source } : {}),
    invoice: {
      format: invoice.format,
      reference: invoice.reference,
      payee: invoice.payee,
      amount: invoice.amount,
      amountRaw: invoice.amountRaw.toString(),
      token: { symbol: invoice.token.symbol, decimals: invoice.token.decimals, address: invoice.token.address, isNative: invoice.token.isNative },
      dueDate: invoice.dueDate,
    },
    summary: {
      lineItemsCount: invoice.items?.length || 1,
      subtotal: invoice.subtotal,
      tax: invoice.tax,
      total: `${invoice.amount} ${invoice.token.symbol}`,
      memo: `INV:${invoice.reference}`,
      calldataEncoding,
    },
    tx,
    ...(extra.chain ? { chain: extra.chain } : {}),
    flags,
  };
}

const short = (h: string) => (h.length > 60 ? `${h.slice(0, 50)}…${h.slice(-8)}` : h);

/** The part a person reads before signing: who gets what, what the wallet will be asked to send, and the checks. */
export function formatPaymentSummary(plan: PaymentPlan): string {
  const inv = plan.invoice;
  const out = [
    `Pay ${inv.amount} ${inv.token.symbol} to ${inv.payee}`,
    `  invoice    ${inv.reference} (${inv.format})${inv.dueDate ? `, due ${inv.dueDate}` : ""}`,
    `  network    Pharos mainnet, chain ${plan.tx.chainId}`,
    `  token      ${inv.token.isNative ? "PROS (native)" : `${inv.token.symbol} ${inv.token.address}`}`,
    `  reference  "${plan.summary.memo}" goes into the tx input (${plan.summary.calldataEncoding})`,
    ``,
    `Unsigned transaction`,
    `  to         ${plan.tx.to}`,
    `  value      ${BigInt(plan.tx.value).toString()} wei${inv.token.isNative ? ` (${inv.amount} PROS)` : ""}`,
    `  data       ${short(plan.tx.data)}`,
    `  chainId    ${plan.tx.chainId}${plan.tx.gasLimit ? `\n  gas        ${BigInt(plan.tx.gasLimit)} (estimate + 20%)` : ""}`,
  ];
  if (plan.chain) {
    const c = plan.chain;
    out.push(``, `Checked on Pharos at block ${c.block}`);
    if (c.from) out.push(`  payer      ${c.from} holds ${c.payerHolds} ${inv.token.symbol}`);
    if (c.gasEstimate) out.push(`  dry run    went through, ${c.gasEstimate} gas at ${c.gasPriceGwei} gwei, about ${c.feePros} PROS fee`);
    else out.push(`  dry run    not done (pass --from <your wallet> to check balance and simulate)`);
  }
  const notes = plan.flags.filter((f) => f.severity !== "FATAL");
  if (notes.length) out.push(``, ...notes.map((f) => `  ${f.severity === "WARNING" ? "!" : "i"} ${f.code}: ${f.message}${f.proof ? ` ${f.proof}` : ""}`));
  return out.join("\n");
}
