import { resolve } from "node:path";
import type { Hex, PublicClient } from "viem";
import { parseInvoice } from "./parser/index.js";
import { validateInvoice } from "./validator.js";
import { createPaymentPlan } from "./tx.js";
import { checkOnChain } from "./chain.js";
import type { PaymentPlan, RawInvoice, ValidationFlag } from "./types.js";

export interface Outcome {
  raw: RawInvoice;
  flags: ValidationFlag[];
  plan?: PaymentPlan;
}

/**
 * Invoice file in, plan out, or the reasons there is none. The same path runs for `plan` and again inside `sign`
 * right before the wallet is asked, so a stale or hand-edited plan file never reaches a signature.
 */
export async function planFromFile(
  file: string,
  opts: { from?: Hex; allowExpired?: boolean; client?: PublicClient } = {},
): Promise<Outcome> {
  const raw = parseInvoice(file);
  const paper = validateInvoice(raw, { allowExpired: opts.allowExpired });
  if (!paper.ok || !paper.invoice) return { raw, flags: paper.flags };

  const draft = createPaymentPlan(paper.invoice, paper.flags);
  if (!opts.client) return { raw, flags: paper.flags, plan: { ...draft, source: resolve(file) } };

  const onChain = await checkOnChain(opts.client, paper.invoice, draft.tx, opts.from);
  const flags = [...paper.flags, ...onChain.flags];
  if (flags.some((f) => f.severity === "FATAL")) return { raw, flags };
  return {
    raw,
    flags,
    plan: createPaymentPlan(paper.invoice, flags, { chain: onChain.chain, gasLimit: onChain.gasLimit, source: resolve(file) }),
  };
}
