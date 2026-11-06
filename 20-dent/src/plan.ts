// Turns "move X from A to B" into the exact transactions the user's own wallet will sign, in order, each with
// a gas figure. Gas comes from eth_estimateGas from the user's address, with storage overrides standing in for
// what the earlier steps will have done by then. Nothing here signs or sends.
import { encodeFunctionData, maxUint256, type Hex } from "viem";
import { aavePool, erc20, erc4626, stpros, wpros } from "./abis.js";
import type { Chain, Overrides } from "./chain.js";
import { explainRevert, mergeOverrides, nativeOverride, tokenOverride } from "./reads.js";
import type { Reading } from "./sources.js";
import { STPROS, STPROS_CLAIM_GAS_OBSERVED, WPROS } from "./venues.js";

export interface Step {
  /** What the wallet is asked to do, in words. */
  says: string;
  to: string;
  data: Hex;
  value: string;
  /** 1 = sign now; 2 = only after the unbonding wait. */
  phase: 1 | 2;
  gas?: string;
  gasHow: "estimated" | "observed" | "unknown";
  gasWhy?: string;
  /** Simulations need state the earlier steps will have created; these overrides stand in for it. */
  simOverrides?: Overrides;
}

export interface Plan {
  tool: "dent";
  createdAt: string;
  chainId: 1672;
  wallet: string;
  lane: "USDC" | "PROS";
  from: string;
  to: string;
  amount: string;
  holdDays: number;
  minGain: number;
  waitSeconds: number;
  steps: Step[];
}

type Form = "native" | "token";

const call = (abi: Parameters<typeof encodeFunctionData>[0]["abi"], functionName: string, args: unknown[] = []) =>
  encodeFunctionData({ abi, functionName, args } as never);

/** Exit steps, plus what form the money is in afterwards (native PROS or the lane's ERC-20). */
export function exitSteps(from: Reading, wallet: string, amount: bigint, nextAsset: string): { steps: Step[]; form: Form } {
  const s = from.source;
  const w = wallet as Hex;
  const steps: Step[] = [];
  if (s.kind === "idle") return { steps, form: s.asset === "native" ? "native" : "token" };
  if (s.kind === "aave") {
    // Withdrawing everything uses type(uint256).max, so interest earned until the block it lands in comes along too.
    const all = amount >= from.held;
    steps.push({
      says: `withdraw ${all ? "everything" : amount.toString()} from ${s.name}`,
      to: s.address!,
      data: call(aavePool, "withdraw", [s.asset, all ? maxUint256 : amount, w]),
      value: "0",
      phase: 1,
      gasHow: "estimated",
    });
    if (s.asset === WPROS && nextAsset !== WPROS) {
      steps.push({ says: "unwrap WPROS to PROS", to: WPROS, data: call(wpros, "withdraw", [amount]), value: "0", phase: 1, gasHow: "estimated", simOverrides: tokenOverride(WPROS, wallet, amount) });
      return { steps, form: "native" };
    }
    return { steps, form: "token" };
  }
  if (s.kind === "vault") {
    const shares = amount >= from.held ? from.heldShares : (from.heldShares * amount) / (from.held || 1n);
    steps.push({ says: `redeem ${shares} shares of ${s.name}`, to: s.address!, data: call(erc4626, "redeem", [shares, w, w]), value: "0", phase: 1, gasHow: "estimated" });
    return { steps, form: "token" };
  }
  if (s.kind === "stpros") {
    const shares = amount >= from.held ? from.heldShares : (from.heldShares * amount) / (from.held || 1n);
    steps.push({ says: `redeem ${shares} stPROS (starts the unbonding wait)`, to: STPROS, data: call(erc4626, "redeem", [shares, w, w]), value: "0", phase: 1, gasHow: "estimated" });
    steps.push({
      says: "claim the unstaked PROS",
      to: STPROS,
      data: call(stpros, "withdrawCompleteToPROS"),
      value: "0",
      phase: 2,
      gas: STPROS_CLAIM_GAS_OBSERVED.toString(),
      gasHow: "observed",
      gasWhy: "can't be simulated before the redeem exists; highest gas of recent real claims",
    });
    return { steps, form: "native" };
  }
  throw new Error(`dent doesn't plan exits from ${s.name}`);
}

export function entrySteps(to: Reading, wallet: string, amount: bigint, form: Form, phase: 1 | 2): Step[] {
  const s = to.source;
  const w = wallet as Hex;
  const steps: Step[] = [];
  if (s.kind === "idle") {
    if (s.lane === "PROS" && form === "token") steps.push({ says: "unwrap WPROS to PROS", to: WPROS, data: call(wpros, "withdraw", [amount]), value: "0", phase, gasHow: "estimated", simOverrides: tokenOverride(WPROS, wallet, amount) });
    return steps;
  }
  if (s.kind === "stpros") {
    steps.push({ says: `stake ${amount} wei PROS with Faroo for stPROS`, to: STPROS, data: call(stpros, "depositWithPROS"), value: amount.toString(), phase, gasHow: "estimated", simOverrides: nativeOverride(wallet, amount + 10n ** 18n) });
    return steps;
  }
  const token = s.asset;
  if (token === WPROS && form === "native") {
    steps.push({ says: `wrap ${amount} wei PROS into WPROS`, to: WPROS, data: call(wpros, "deposit"), value: amount.toString(), phase, gasHow: "estimated", simOverrides: nativeOverride(wallet, amount + 10n ** 18n) });
  }
  const spender = s.address!;
  steps.push({ says: `let ${s.name} take ${amount} of your ${token === WPROS ? "WPROS" : "USDC"}`, to: token, data: call(erc20, "approve", [spender, amount]), value: "0", phase, gasHow: "estimated", simOverrides: tokenOverride(token, wallet, amount) });
  const funded = tokenOverride(token, wallet, amount, spender);
  if (s.kind === "aave") steps.push({ says: `supply ${amount} to ${s.name}`, to: spender, data: call(aavePool, "supply", [token, amount, w, 0]), value: "0", phase, gasHow: "estimated", simOverrides: funded });
  else if (s.kind === "vault") steps.push({ says: `deposit ${amount} into ${s.name}`, to: spender, data: call(erc4626, "deposit", [amount, w]), value: "0", phase, gasHow: "estimated", simOverrides: funded });
  else throw new Error(`dent doesn't plan entries into ${s.name}`);
  return steps;
}

/** Asks the node how much gas each step would burn from the user's address. A revert here is a finding. */
export async function estimateAll(chain: Chain, wallet: string, steps: Step[]): Promise<{ total?: bigint; problem?: string }> {
  let total = 0n;
  for (const st of steps) {
    if (st.gasHow === "observed") {
      total += BigInt(st.gas!);
      continue;
    }
    const tx = { from: wallet, to: st.to, data: st.data, value: BigInt(st.value) };
    const ov = st.simOverrides ? mergeOverrides(st.simOverrides, nativeOverride(wallet, BigInt(st.value) + 10n ** 18n)) : undefined;
    const r = await chain.estimateGas(tx, ov);
    if (!r.ok || r.gas === undefined) {
      st.gasHow = "unknown";
      st.gasWhy = explainRevert(r.ok ? "0x" : r.revert, r.ok ? "no gas figure" : r.message);
      return { problem: `"${st.says}" would revert: ${st.gasWhy}` };
    }
    st.gas = r.gas.toString();
    total += r.gas;
  }
  return { total };
}

export function buildSteps(from: Reading, to: Reading, wallet: string, amount: bigint): Step[] {
  const exit = exitSteps(from, wallet, amount, to.source.asset);
  const phase = exit.steps.some((s) => s.phase === 2) ? 2 : 1;
  return [...exit.steps, ...entrySteps(to, wallet, amount, exit.form, phase)];
}
