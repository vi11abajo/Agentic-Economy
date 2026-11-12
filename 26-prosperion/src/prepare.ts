// Turning "I want in on this launch" into a link the visitor signs. Three roads lead here: a Telegram alert, the
// "Prepare first buy" button on /launches/, and the agent when someone in the chat asks for it. All three end in the
// same saved request and the same sign page, which re-checks the market and builds the transaction only when the
// wallet is about to open. Nothing here signs or sends; a request is just a row with the visitor's own limits.
import { parseEther, type Address } from "viem";
import { requestUrl } from "./links.js";
import type { MarketCheck } from "./market.js";
import type { Store } from "./store.js";

// The sign page re-quotes at signing time and asks the curve for at least 98% of that quote.
export const MIN_OUT_BPS = 9800;
// A sanity fence, not advice: a typo from the agent or a slipped zero should not reach a wallet screen.
export const MAX_PREPARE_WEI = parseEther("1000");

export type RequestSource = "alert" | "page" | "agent";
export interface PrepareInput {
  market: Address;
  owner: Address;
  amountWei: bigint;
  /** Go ahead only while at most this much PROS sits in the curve. Default: exactly what is in it now. */
  maxReserveBeforeWei?: bigint;
  source: RequestSource;
}
export type Prepared =
  | { ok: true; id: string; url: string; check?: MarketCheck }
  | { ok: false; refusal: string; check?: MarketCheck };

/** Why a buy should not go ahead right now, in plain words; undefined if it may. */
export function refusalFor(c: MarketCheck, maxReserveBeforeWei: bigint, acceptedImpl: string): string | undefined {
  if (!c.genuine) return "Not a Prosper market: the factory does not list it.";
  if (c.phase !== 0) return `The market left the curve (phase ${c.phase}); there is nothing to be first into.`;
  if (c.reserveBefore > maxReserveBeforeWei)
    return `No longer first: ${Number(c.reserveBefore) / 1e18} PROS is already in the curve, your limit was ${Number(maxReserveBeforeWei) / 1e18}.`;
  if (c.implNow.toLowerCase() !== acceptedImpl.toLowerCase())
    return `Market code changed since this link was made (now ${c.implNow}). Read what changed before agreeing to it again.`;
  return undefined;
}

export async function prepareBuy(
  store: Store, check: (market: Address, amountIn: bigint) => Promise<MarketCheck>, i: PrepareInput,
): Promise<Prepared> {
  if (i.amountWei <= 0n || i.amountWei > MAX_PREPARE_WEI)
    return { ok: false, refusal: `The amount must be between 0 and ${Number(MAX_PREPARE_WEI) / 1e18} PROS.` };
  const c = await check(i.market, i.amountWei);
  // Default limit: what is in the curve right now. On an empty curve that means "only if I am still first".
  const maxReserve = i.maxReserveBeforeWei ?? c.reserveBefore;
  const refusal = refusalFor(c, maxReserve, c.implNow);
  if (refusal) return { ok: false, refusal, check: c };
  const id = store.saveRequest({
    kind: "buy",
    createdBlock: c.block,
    params: {
      market: i.market, owner: i.owner, amountWei: i.amountWei.toString(), minOutBps: MIN_OUT_BPS,
      maxReserveBeforeWei: maxReserve.toString(), acceptedImpl: c.implNow, source: i.source,
    },
  });
  return { ok: true, id, url: requestUrl(id), check: c };
}
