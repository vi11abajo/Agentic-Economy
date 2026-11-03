// Where a Prosper token trades and what PROS buys there. Graduated tokens sit in V2 pools against WPROS (the
// factory has no working getPair, so we walk its list of pairs); tokens still on their bonding curve are bought
// from their market contract.
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Address } from "viem";
import type { Chain } from "./chain.js";
import { CURVE_MARKETS, V2_FACTORY, WPROS, erc20Abi, factoryAbi, marketAbi, pairAbi } from "./book.js";

export type Venue =
  | { kind: "pool"; symbol: string; token: Address; pair: Address; wprosIs0: boolean; reserveIn: bigint; reserveOut: bigint }
  | { kind: "curve"; symbol: string; token: Address; market: Address; phase: number; endsAt: bigint; failed: boolean };

// Phase 3 is what the pMusk market reports after its curve missed its goal by the deadline: it still sells
// on the curve, it just never made it to a pool. Worth a warning before anyone buys.
const FAILED_PHASE = 3;

type ReadAbi = typeof erc20Abi | typeof factoryAbi | typeof pairAbi | typeof marketAbi;
async function read<T>(chain: Chain, to: Address, abi: ReadAbi, functionName: string, args: unknown[] = []): Promise<T> {
  const data = encodeFunctionData({ abi, functionName, args } as Parameters<typeof encodeFunctionData>[0]);
  const r = await chain.call({ to, data });
  if (!r.ok) throw new Error(`${functionName} on ${to} reverted: ${r.message}`);
  return decodeFunctionResult({ abi, functionName, data: r.data } as Parameters<typeof decodeFunctionResult>[0]) as T;
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export async function resolveVenue(chain: Chain, token: string, market?: Address): Promise<Venue> {
  const curve = market ? { market } : Object.entries(CURVE_MARKETS).find(([sym, c]) => same(sym, token) || same(c.token, token))?.[1];
  if (curve) {
    const [tokenAddr, phase, endsAt] = await Promise.all([
      read<Address>(chain, curve.market, marketAbi, "pToken"),
      read<number>(chain, curve.market, marketAbi, "phase"),
      read<bigint>(chain, curve.market, marketAbi, "endsAt"),
    ]);
    const symbol = await read<string>(chain, tokenAddr, erc20Abi, "symbol");
    return { kind: "curve", symbol: Object.keys(CURVE_MARKETS).find((s) => same(CURVE_MARKETS[s].token, tokenAddr)) ?? symbol, token: getAddress(tokenAddr), market: getAddress(curve.market), phase: Number(phase), endsAt, failed: Number(phase) === FAILED_PHASE };
  }

  const count = await read<bigint>(chain, V2_FACTORY, factoryAbi, "allPairsLength");
  for (let i = 0n; i < count; i++) {
    const pair = await read<Address>(chain, V2_FACTORY, factoryAbi, "allPairs", [i]);
    const [t0, t1] = [await read<Address>(chain, pair, pairAbi, "token0"), await read<Address>(chain, pair, pairAbi, "token1")];
    const wprosIs0 = same(t0, WPROS);
    if (!wprosIs0 && !same(t1, WPROS)) continue;
    const other = wprosIs0 ? t1 : t0;
    const symbol = await read<string>(chain, other, erc20Abi, "symbol");
    // Pool tokens call themselves "TACO", people call them "pTACO": accept both.
    const matches = isAddress(token) ? same(other, token) : same(token, symbol) || same(token, `p${symbol}`);
    if (!matches) continue;
    const [r0, r1] = await read<[bigint, bigint, number]>(chain, pair, pairAbi, "getReserves");
    return { kind: "pool", symbol: symbol.startsWith("p") ? symbol : `p${symbol}`, token: getAddress(other), pair: getAddress(pair), wprosIs0, reserveIn: wprosIs0 ? r0 : r1, reserveOut: wprosIs0 ? r1 : r0 };
  }
  throw new Error(`couldn't find ${token}: it's not in a Prosper pool, and no curve market is known for it (give its market address)`);
}

/** What `prosIn` buys in a Prosper V2 pool: the usual constant-product quote with the pool's 0.5% fee. */
export function quotePool(v: Extract<Venue, { kind: "pool" }>, prosIn: bigint): bigint {
  return (prosIn * 9950n * v.reserveOut) / (v.reserveIn * 10000n + prosIn * 9950n);
}

/** The curve's own quote: how much of the PROS it would really use, and how many tokens come out. */
export async function quoteCurve(chain: Chain, v: Extract<Venue, { kind: "curve" }>, prosIn: bigint): Promise<{ usedGross: bigint; out: bigint }> {
  const [usedGross, , , out] = await read<[bigint, bigint, bigint, bigint]>(chain, v.market, marketAbi, "quoteBuy", [prosIn]);
  return { usedGross, out };
}

