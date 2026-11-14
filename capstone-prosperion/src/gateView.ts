// What the gate holds for one wallet, put the way the agent should say it: limits in PROS, what is left for today,
// and whether the market code the wallet agreed to is still the one Prosper runs. The agent reads this before any
// buy talk instead of guessing; changing limits stays on the Launches page, where the wallet signs setLimits.
import { formatEther, type Address } from "viem";
import type { GateLimits } from "./api.js";
import { SITE } from "./links.js";

export interface GateLimitsView {
  block: bigint;
  state: "not set" | "stopped" | "active";
  perBuyPros: string;
  perDayPros: string;
  spentTodayPros: string;
  leftTodayPros: string;
  /** the most PROS already in a curve for a buy to go through */
  maxInCurvePros: string;
  marketCodeAccepted: boolean;
  /** the gate's day ends here (unix seconds, UTC midnight) */
  dayEndsAt: number;
  changeAt: string;
  note: string;
}

export function gateLimitsView(i: { block: bigint; limits: GateLimits | null; spent: bigint; implNow: Address; dayEndsAt: number }): GateLimitsView {
  const p = (w: bigint) => formatEther(w);
  const l = i.limits;
  const changeAt = `${SITE}/launches/#limits`;
  const common = { block: i.block, spentTodayPros: p(i.spent), dayEndsAt: i.dayEndsAt, changeAt };
  if (!l) {
    return {
      ...common, state: "not set", perBuyPros: "0", perDayPros: "0", leftTodayPros: "0", maxInCurvePros: "0", marketCodeAccepted: false,
      note: "This wallet never set limits on the gate. The first buy link offers a setLimits step before the buy.",
    };
  }
  const accepted = l.acceptedMarketImpl.toLowerCase() === i.implNow.toLowerCase();
  const left = l.maxPerDay > i.spent ? l.maxPerDay - i.spent : 0n;
  const stopped = l.maxPerBuy === 0n;
  const notes = [
    stopped ? "All buys are stopped: every buy through the gate reverts until new limits are set." : "",
    !accepted ? "Prosper upgraded the market code since this wallet agreed to it: buys revert (ImplChanged) until the wallet accepts the new code by setting limits again." : "",
    "Change them under Your buy limits on the Launches page; the wallet signs one setLimits transaction.",
  ].filter(Boolean);
  return {
    ...common, state: stopped ? "stopped" : "active",
    perBuyPros: p(l.maxPerBuy), perDayPros: p(l.maxPerDay), leftTodayPros: p(left), maxInCurvePros: p(l.maxReserveBefore),
    marketCodeAccepted: accepted, note: notes.join(" "),
  };
}
