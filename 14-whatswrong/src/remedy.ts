// The part a support desk usually skips: after saying what to do, actually try it. We rebuild the transaction the
// way the advice says and replay it (on the latest block, or at the moment it was sent when that's the fairer
// question), so "do X and it will work" is something we checked. Where there's nothing to replay, we just look
// the number up and say that's what we did.
import { decodeFunctionData, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Hex } from "viem";
import { callOf, erc20, peek, tokenAmount, type Autopsy, type TokenAmount } from "./autopsy.js";
import { readTheRevert, type Revert } from "./clues.js";
import type { CallSpec, Echo, StateTweaks, Witness } from "./witness.js";

export interface FixCheck {
  /** "replayed": we ran a patched transaction. "looked up": we only read a balance or the vault's cash. */
  how: "replayed" | "looked up";
  /** Did the patched transaction go through (or, for a look-up, is the shortfall gone)? */
  passes: boolean;
  /** One line on what we changed or read. */
  tried: string;
  /** If the patched version still fails, what it complained about next (often the real second problem). */
  nextProblem?: Revert;
  numbers?: Record<string, unknown>;
}

export interface Remedy {
  /** Would the very same transaction, unchanged, go through right now? And if not, what does it say today? */
  wouldPassNow: boolean;
  nowSays?: Revert;
  check?: FixCheck;
  notes: string[];
}

// Faroswap's SwapRouter is the classic Uniswap V3 one (with a deadline inside the params).
const swapRouter = parseAbi([
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactOutputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum,uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountIn)",
]);
const vault4626 = parseAbi(["function maxWithdraw(address owner) view returns (uint256)", "function asset() view returns (address)"]);

type SwapParams = Record<string, unknown> & { deadline: bigint; amountOutMinimum?: bigint };

/** Pull the single swap out of a router call (bare, or wrapped in multicall) and give back a way to put it back. */
function findTheSwap(input: string): { fn: "exactInputSingle" | "exactOutputSingle"; params: SwapParams; rebuild: (p: SwapParams) => Hex } | undefined {
  try {
    const top = decodeFunctionData({ abi: swapRouter, data: input as Hex });
    if (top.functionName === "exactInputSingle" || top.functionName === "exactOutputSingle") {
      const fn = top.functionName;
      return { fn, params: top.args[0] as SwapParams, rebuild: (p) => encodeFunctionData({ abi: swapRouter, functionName: fn, args: [p as never] }) };
    }
    if (top.functionName === "multicall") {
      const inner = top.args[0] as Hex[];
      for (let slot = 0; slot < inner.length; slot++) {
        const found = findTheSwap(inner[slot]);
        if (found) {
          return {
            fn: found.fn,
            params: found.params,
            rebuild: (p) => encodeFunctionData({ abi: swapRouter, functionName: "multicall", args: [inner.map((piece, j) => (j === slot ? found.rebuild(p) : piece))] }),
          };
        }
      }
    }
  } catch {
    /* not a Faroswap router call */
  }
  return undefined;
}

/**
 * Where does this token keep allowances? We don't know its layout, so we try the usual mapping slots: write a
 * marker value through a state override and see whether allowance() reads it back. Works for OpenZeppelin, Circle
 * (FiatToken) and WETH-style tokens; namespaced (ERC-7201) storage won't be found, and we say so.
 */
async function allowanceSlot(witness: Witness, token: string, owner: string, spender: string): Promise<string | undefined> {
  const marker = 0x5eedn;
  for (let base = 0n; base <= 12n; base++) {
    const inner = keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner as Hex, base]));
    const slot = keccak256(encodeAbiParameters([{ type: "address" }, { type: "bytes32" }], [spender as Hex, inner]));
    const probe = await witness.replayPatched(
      { from: owner, to: token, data: encodeFunctionData({ abi: erc20, functionName: "allowance", args: [owner as Hex, spender as Hex] }) },
      { [token]: { stateDiff: { [slot]: `0x${marker.toString(16).padStart(64, "0")}` } } },
    );
    if (!probe.reverted && BigInt(probe.returned) === marker) return slot;
  }
  return undefined;
}

const wentThrough = (echo: Echo) => !echo.reverted;
const complaintOf = (echo: Echo) => (echo.reverted ? readTheRevert(echo.revertData) : undefined);
const NOW_SLACK = 600n; // a fresh deadline: ten minutes after the latest block

export async function proveTheFix(witness: Witness, verdict: Autopsy): Promise<Remedy> {
  const call: CallSpec = callOf(verdict.tx);
  // A failed deployment has nothing to replay against, and a success has nothing to fix.
  if (verdict.kind === "deployment_failed" || verdict.kind === "not_failed") return { wouldPassNow: false, notes: [] };

  const today = await witness.replay(call, "latest");
  const remedy: Remedy = { wouldPassNow: wentThrough(today), nowSays: complaintOf(today), notes: [] };
  try {
    await checkTheAdvice(witness, verdict, call, remedy);
  } catch (err) {
    // The diagnosis already stands; a hiccup while checking the fix shouldn't throw it away.
    remedy.notes.push(`couldn't finish checking the fix: ${(err as Error).message.slice(0, 160)}`);
  }
  return remedy;
}

async function checkTheAdvice(witness: Witness, verdict: Autopsy, call: CallSpec, remedy: Remedy): Promise<void> {
  const facts = verdict.facts as Record<string, unknown>;

  if (verdict.kind === "out_of_gas") {
    // Back at the moment it was sent, would a bigger tank have been enough? Try 2x, 4x and 8x the old limit there.
    for (const times of [2n, 4n, 8n]) {
      const roomy = verdict.gasLimit * times;
      const thenEcho = await witness.replay({ ...call, gas: `0x${roomy.toString(16)}` }, verdict.block - 1);
      if (wentThrough(thenEcho)) {
        remedy.check = { how: "replayed", passes: true, tried: `the same call at the block before it, with ${times}x the gas (${roomy})`, numbers: { hadLimit: verdict.gasLimit, enoughWas: roomy } };
        break;
      }
    }
    const estimate = await witness.estimateGas(call);
    if (estimate) remedy.notes.push(`a fresh estimate for today is ${estimate} gas`);
  }

  if (verdict.kind === "allowance") {
    const owner = facts.owner as string | undefined;
    const spender = facts.spender as string | undefined;
    const needed = facts.needed as TokenAmount | undefined;
    if (owner && spender && needed) {
      const slot = await allowanceSlot(witness, needed.token, owner, spender);
      if (slot) {
        const tweaks: StateTweaks = { [needed.token]: { stateDiff: { [slot]: `0x${needed.raw.toString(16).padStart(64, "0")}` } } };
        const echo = await witness.replayPatched(call, tweaks, verdict.block - 1);
        remedy.check = { how: "replayed", passes: wentThrough(echo), nextProblem: complaintOf(echo), tried: `the same call at the block before it, as if ${spender} had been approved for ${needed.pretty}`, numbers: { approveFor: needed.pretty, spender } };
      } else remedy.notes.push("couldn't find where this token stores allowances, so the approve wasn't simulated");
    }
  }

  if (verdict.kind === "balance") {
    const who = (facts.owner ?? facts.payer) as string | undefined;
    const need = (facts.needed ?? facts.wanted) as TokenAmount | undefined;
    if (who && need) {
      const holdsNow = await peek<bigint>(witness, need.token, erc20, "balanceOf", [who], "latest");
      if (holdsNow !== undefined) {
        const has = await tokenAmount(witness, need.token, holdsNow);
        remedy.check = { how: "looked up", passes: holdsNow >= need.raw, tried: `${who}'s ${has.symbol} balance now`, numbers: { needs: need.pretty, hasNow: has.pretty } };
      }
    }
  }

  // A swap beaten inside its block is a slippage story too, so it gets the same treatment.
  if (verdict.kind === "deadline" || verdict.kind === "slippage" || verdict.kind === "same_block") {
    const swap = findTheSwap(verdict.tx.input);
    if (!swap) {
      if (verdict.kind !== "deadline") remedy.notes.push("this contract's call layout isn't public, so only the unchanged transaction was checked");
      return;
    }
    const head = await witness.block("latest");
    const fresh = BigInt(head.timestamp) + NOW_SLACK;
    const tokenOut = String(swap.params.tokenOut);
    const askedFor = swap.params.amountOutMinimum;

    // First the gentlest fix: same swap, same minimum, just a deadline that hasn't passed yet.
    const justRefreshed = await witness.replay({ ...call, data: swap.rebuild({ ...swap.params, deadline: fresh }) }, "latest");
    if (wentThrough(justRefreshed) || verdict.kind === "deadline" || swap.fn !== "exactInputSingle") {
      remedy.check = {
        how: "replayed",
        passes: wentThrough(justRefreshed),
        nextProblem: complaintOf(justRefreshed),
        tried: "the same swap with only the deadline moved to 10 minutes from now (your minimum unchanged)",
        numbers: { oldDeadline: swap.params.deadline, ...(askedFor !== undefined ? { askedAtLeast: (await tokenAmount(witness, tokenOut, askedFor)).pretty } : {}) },
      };
      return;
    }

    // The minimum itself is the obstacle: ask the pool what this swap pays today with no minimum at all...
    const open = await witness.replay({ ...call, data: encodeFunctionData({ abi: swapRouter, functionName: "exactInputSingle", args: [{ ...swap.params, deadline: fresh, amountOutMinimum: 0n } as never] }) }, "latest");
    if (open.reverted) {
      remedy.check = { how: "replayed", passes: false, nextProblem: complaintOf(open), tried: "the same swap with a fresh deadline and no minimum at all" };
      return;
    }
    const paysNow = decodeFunctionResult({ abi: swapRouter, functionName: "exactInputSingle", data: open.returned as Hex }) as bigint;
    // ...then leave 0.5% of room. This proves the swap can execute today; it can't promise the price stays put.
    const fairMin = (paysNow * 995n) / 1000n;
    const echo = await witness.replay({ ...call, data: swap.rebuild({ ...swap.params, deadline: fresh, amountOutMinimum: fairMin }) }, "latest");
    remedy.check = {
      how: "replayed",
      passes: wentThrough(echo),
      nextProblem: complaintOf(echo),
      tried: "the same swap with a fresh deadline and the minimum set 0.5% under what the pool pays right now",
      numbers: { askedAtLeast: (await tokenAmount(witness, tokenOut, askedFor ?? 0n)).pretty, poolPaysNow: (await tokenAmount(witness, tokenOut, paysNow)).pretty, suggestedMinimum: (await tokenAmount(witness, tokenOut, fairMin)).pretty },
    };
  }

  if (verdict.kind === "vault_liquidity" && verdict.tx.to) {
    const wanted = facts.wanted as TokenAmount | undefined;
    const vault = verdict.tx.to;
    const canTakeNow = await peek<bigint>(witness, vault, vault4626, "maxWithdraw", [verdict.tx.from], "latest");
    const asset = (await peek<string>(witness, vault, vault4626, "asset", [], "latest")) ?? wanted?.token;
    const cashNow = asset ? await peek<bigint>(witness, asset, erc20, "balanceOf", [vault], "latest") : undefined;
    if (asset && wanted && cashNow !== undefined) {
      remedy.check = {
        how: "looked up",
        passes: cashNow >= wanted.raw,
        tried: "the vault's idle cash now, and how much it lets this wallet take out",
        numbers: { wanted: wanted.pretty, vaultCashNow: (await tokenAmount(witness, asset, cashNow)).pretty, maxWithdrawNow: canTakeNow === undefined ? "unknown" : (await tokenAmount(witness, asset, canTakeNow)).pretty },
      };
    }
  }
}
