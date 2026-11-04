// What a draw is allowed to look like. The request decides pool, winners, amount, token and delay; the caps
// come only from config.json in the data folder, so nobody can talk the agent into a bigger payout from chat.
import { formatUnits, parseUnits } from "viem";

export type Token = "USDC" | "PROS";
export type DrawParams = { pool: number; winners: number; amount: string; token: Token; delay: number };
export type Caps = { max_total_usdc: string; max_total_pros: string; lookback_blocks: number };

export const DEFAULTS: DrawParams = { pool: 30, winners: 3, amount: "0.00001", token: "USDC", delay: 5 };
export const DEFAULT_CAPS: Caps = { max_total_usdc: "0.0001", max_total_pros: "0.001", lookback_blocks: 50000 };

export const DECIMALS: Record<Token, number> = { USDC: 6, PROS: 18 };

/** The per-winner amount in the token's smallest units. Only call it on params that passed checkParams. */
export function amountRaw(p: DrawParams): bigint {
  return parseUnits(p.amount, DECIMALS[p.token]);
}

/** Everything wrong with a draw request, one plain sentence each. Empty means good to go. */
export function checkParams(p: DrawParams, caps: Caps): string[] {
  const nope: string[] = [];
  if (!Number.isInteger(p.pool) || p.pool < 2 || p.pool > 100) nope.push(`pool must be 2..100 people, got ${p.pool}`);
  if (!Number.isInteger(p.winners) || p.winners < 1 || p.winners > 10) nope.push(`winners must be 1..10, got ${p.winners}`);
  if (p.winners >= p.pool) nope.push(`a draw needs fewer winners than people (${p.winners} winners, pool of ${p.pool})`);
  if (!Number.isInteger(p.delay) || p.delay < 1 || p.delay > 50) nope.push(`delay must be 1..50 blocks, got ${p.delay}`);
  if (p.token !== "USDC" && p.token !== "PROS") nope.push(`token must be USDC or PROS, got ${p.token}`);
  else nope.push(...amountProblems(p, caps));
  return nope;
}

function amountProblems(p: DrawParams, caps: Caps): string[] {
  if (!/^\d+(\.\d+)?$/.test(p.amount)) return [`amount must be a plain positive number like 0.00001, got "${p.amount}"`];
  const decimals = DECIMALS[p.token];
  const fraction = p.amount.split(".")[1] ?? "";
  if (fraction.length > decimals) {
    // parseUnits would quietly round; better to say what's going on.
    const tooSmall = parseUnits(p.amount, decimals) === 0n;
    return [tooSmall ? `${p.amount} is below the smallest ${p.token} unit (${decimals} decimals)` : `${p.token} has only ${decimals} decimals, ${p.amount} has more`];
  }
  const each = parseUnits(p.amount, decimals);
  if (each === 0n) return ["amount must be more than zero"];
  const capName = p.token === "USDC" ? "max_total_usdc" : "max_total_pros";
  const cap = parseUnits(caps[capName], decimals);
  const total = each * BigInt(p.winners);
  if (total > cap) {
    return [`${p.winners} x ${p.amount} = ${formatUnits(total, decimals)} ${p.token} is over the cap ${capName} = ${caps[capName]} (config.json in the data folder; only the user changes it)`];
  }
  return [];
}
