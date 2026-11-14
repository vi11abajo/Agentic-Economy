// The Early Depositor Reward unlocks in steps as NAV grows. The table and the current step come from Prosper's API;
// the chain has neither the formula nor the 7-day median it is measured on, so this is a hypothesis we label as one.
import type { Address } from "viem";
import { incentives } from "./prosperApi.js";
import { readVault } from "./vault.js";

export interface RewardUnlock {
  vault: Address;
  block: bigint;
  hypothesis: true;
  source: string;
  currentUnlockBps: number;
  navUnlocks: { thresholdBps: number; cumulativeUnlockBps: number }[];
  /** NAV per share now vs 1.00 at launch, in bps (10000 = flat). Read on chain. */
  navNowBps: number;
  nextStep: { thresholdBps: number; cumulativeUnlockBps: number } | null;
}

export async function rewardUnlock(vault: Address): Promise<RewardUnlock> {
  const [inc, v] = await Promise.all([incentives(vault), readVault(vault)]);
  const navNowBps = Number(v.navPerShare / 100n); // 6-decimal USDC per share -> bps of 1.00
  return {
    vault: v.vault,
    block: v.block,
    hypothesis: true,
    source: "unlock table and current step: Prosper API; NAV: chain. Prosper measures a 7-day median we cannot see.",
    currentUnlockBps: inc.currentUnlockBps,
    navUnlocks: inc.navUnlocks,
    navNowBps,
    nextStep: inc.navUnlocks.find((s) => s.cumulativeUnlockBps > inc.currentUnlockBps) ?? null,
  };
}
