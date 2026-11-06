// Rehearsing the advice on the real contracts before we give it.
//
// Pharos' public node has no eth_simulateV1, so here's the trick instead: eth_call lets us override any account's
// code for the duration of the call. We put contracts/Runner.sol on the BORROWER's own address and call it from
// that address. Every call Runner makes now has msg.sender = the borrower, so "approve, repay, read health" runs
// as if they did it themselves, against the live pool, and nothing is ever signed or sent. If the wallet doesn't
// hold enough of the token, a second override tops up its balance slot for the rehearsal.
import { decodeFunctionResult, encodeAbiParameters, encodeFunctionData, keccak256, maxUint256, type Abi, type Hex } from "viem";
import { aavePool, erc20, morpho, morphoOracle, runner } from "./abis.js";
import type { Chain, Overrides } from "./chain.js";
import type { Move } from "./health.js";
import type { MarketParams } from "./morpho.js";
import { ask, type At } from "./read.js";
import { MORPHO, RUNNER_CODE } from "./venues.js";

const enc = (abi: Abi, fn: string, args: readonly unknown[]) => encodeFunctionData({ abi, functionName: fn, args } as never);
const word = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

// The OpenZeppelin ERC20Upgradeable namespace (ERC-7201), for tokens that keep balances there.
const OZ_ERC20_NS = 0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00n;
const slotCache = new Map<string, bigint | null>();

const mapSlot = (holder: Hex, slot: bigint) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, slot]));

/**
 * Finds which storage slot a token keeps balances in, by writing a marker into each candidate and asking
 * balanceOf whether it moved. Works for the usual Solidity mapping layouts; returns null for anything exotic,
 * and then we only rehearse with what the wallet really holds.
 */
export async function findBalanceSlot(chain: Chain, token: Hex, holder: Hex, at: At): Promise<bigint | null> {
  const k = token.toLowerCase();
  if (slotCache.has(k)) return slotCache.get(k)!;
  const marker = 0x1234567890abcdefn * 10n ** 20n;
  for (const slot of [...Array.from({ length: 30 }, (_, i) => BigInt(i)), OZ_ERC20_NS]) {
    const ov: Overrides = { [token]: { stateDiff: { [mapSlot(holder, slot)]: word(marker) } } };
    const got = await ask<bigint>(chain, "probe", token, erc20, "balanceOf", [holder], at, ov).catch(() => -1n);
    if (got === marker) {
      slotCache.set(k, slot);
      return slot;
    }
  }
  slotCache.set(k, null);
  return null;
}

export interface Rehearsal {
  ok: boolean;
  /** Health right after the move, as the real contracts compute it. */
  hfAfter?: number;
  /** Why it couldn't run, or the revert. */
  why?: string;
  /** What the wallet holds of the token right now (raw). */
  walletHas: bigint;
  /** True when we had to top up the wallet's balance for the rehearsal. */
  toppedUp: boolean;
}

async function runAs(chain: Chain, wallet: Hex, steps: [Hex, Hex][], at: At, extra: Overrides): Promise<{ ok: true; outs: readonly Hex[] } | { ok: false; why: string }> {
  const data = enc(runner, "run", [steps.map((s) => s[0]), steps.map((s) => s[1])]);
  const ov: Overrides = { ...extra, [wallet]: { ...(extra[wallet] ?? {}), code: RUNNER_CODE } };
  const r = await chain.call({ from: wallet, to: wallet, data }, at, ov);
  if (!r.ok) return { ok: false, why: r.message };
  return { ok: true, outs: decodeFunctionResult({ abi: runner, functionName: "run", data: r.data }) as readonly Hex[] };
}

async function fund(chain: Chain, token: Hex, wallet: Hex, need: bigint, at: At): Promise<{ ov: Overrides; has: bigint; toppedUp: boolean } | { why: string; has: bigint }> {
  const has = await ask<bigint>(chain, "wallet balance", token, erc20, "balanceOf", [wallet], at);
  if (has >= need) return { ov: {}, has, toppedUp: false };
  const slot = await findBalanceSlot(chain, token, wallet, at);
  if (slot === null) return { why: "couldn't find the token's balance slot to top the wallet up for the rehearsal", has };
  return { ov: { [token]: { stateDiff: { [mapSlot(wallet, slot)]: word(need) } } }, has, toppedUp: true };
}

export async function rehearseAave(chain: Chain, pool: Hex, wallet: Hex, move: Move, at: At): Promise<Rehearsal> {
  const f = await fund(chain, move.leg.token, wallet, move.amount, at);
  if ("why" in f) return { ok: false, why: f.why, walletHas: f.has, toppedUp: false };
  const act = move.kind === "repay"
    ? enc(aavePool, "repay", [move.leg.token, move.amount, 2n, wallet])
    : enc(aavePool, "supply", [move.leg.token, move.amount, wallet, 0]);
  const r = await runAs(chain, wallet, [
    [move.leg.token, enc(erc20, "approve", [pool, maxUint256])],
    [pool, act],
    [pool, enc(aavePool, "getUserAccountData", [wallet])],
  ], at, f.ov);
  if (!r.ok) return { ok: false, why: r.why, walletHas: f.has, toppedUp: f.toppedUp };
  const acct = decodeFunctionResult({ abi: aavePool, functionName: "getUserAccountData", data: r.outs[2] }) as readonly bigint[];
  return { ok: true, hfAfter: acct[1] === 0n ? Infinity : Number(acct[5]) / 1e18, walletHas: f.has, toppedUp: f.toppedUp };
}

export async function rehearseMorpho(chain: Chain, id: Hex, m: MarketParams, wallet: Hex, move: Move, debtRaw: bigint, at: At): Promise<Rehearsal> {
  const f = await fund(chain, move.leg.token, wallet, move.amount, at);
  if ("why" in f) return { ok: false, why: f.why, walletHas: f.has, toppedUp: false };
  const params = { ...m };
  let act: Hex;
  if (move.kind === "repay") {
    // Repaying everything by assets can trip on rounding, so a full repay goes by shares, like the Morpho UI does.
    const pos = await ask<readonly [bigint, bigint, bigint]>(chain, "position", MORPHO, morpho, "position", [id, wallet], at);
    act = move.amount >= debtRaw ? enc(morpho, "repay", [params, 0n, pos[1], wallet, "0x"]) : enc(morpho, "repay", [params, move.amount, 0n, wallet, "0x"]);
  } else {
    act = enc(morpho, "supplyCollateral", [params, move.amount, wallet, "0x"]);
  }
  const r = await runAs(chain, wallet, [
    [MORPHO, enc(morpho, "accrueInterest", [params])],
    [move.leg.token, enc(erc20, "approve", [MORPHO, maxUint256])],
    [MORPHO, act],
    [MORPHO, enc(morpho, "position", [id, wallet])],
    [MORPHO, enc(morpho, "market", [id])],
    [m.oracle, enc(morphoOracle, "price", [])],
  ], at, f.ov);
  if (!r.ok) return { ok: false, why: r.why, walletHas: f.has, toppedUp: f.toppedUp };
  const pos = decodeFunctionResult({ abi: morpho, functionName: "position", data: r.outs[3] }) as readonly bigint[];
  const mk = decodeFunctionResult({ abi: morpho, functionName: "market", data: r.outs[4] }) as readonly bigint[];
  const price = decodeFunctionResult({ abi: morphoOracle, functionName: "price", data: r.outs[5] }) as bigint;
  const debt = (pos[1] * (mk[2] + 1n) + (mk[3] + 10n ** 6n) - 1n) / (mk[3] + 10n ** 6n);
  const maxBorrow = (((pos[2] * price) / 10n ** 36n) * m.lltv) / 10n ** 18n;
  return { ok: true, hfAfter: debt === 0n ? Infinity : Number((maxBorrow * 10n ** 12n) / debt) / 1e12, walletHas: f.has, toppedUp: f.toppedUp };
}
