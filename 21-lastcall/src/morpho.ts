// Reading a wallet's loan in one Morpho Blue market. Morpho doesn't store a health factor, so we rebuild it the
// way the contract decides liquidations: collateral x oracle price / 1e36 x LLTV against the debt, with the
// interest since the market's last update added in first (same Taylor expansion Morpho uses).
import { encodeAbiParameters, keccak256, type Hex } from "viem";
import { morpho, morphoIrm, morphoOracle } from "./abis.js";
import type { Chain } from "./chain.js";
import type { Sample } from "./clock.js";
import { priceShape, type Snapshot } from "./health.js";
import { ask, tokenInfo, type At } from "./read.js";
import { MORPHO } from "./venues.js";

const WAD = 10n ** 18n;
const YEAR = 31_536_000;

export interface MarketParams {
  loanToken: Hex;
  collateralToken: Hex;
  oracle: Hex;
  irm: Hex;
  lltv: bigint;
}

export interface MarketState {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
}

export const paramsTuple = (m: MarketParams) => [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv] as const;

/**
 * Morpho's market id IS the hash of its params. If the hash checks out, nobody can change this market's oracle,
 * LLTV or rate model later: a different setting would be a different market. That's the "rules are fixed"
 * line in our output, and it's checked, not assumed.
 */
export function idMatchesParams(id: Hex, m: MarketParams): boolean {
  const enc = encodeAbiParameters(
    [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
    [m.loanToken, m.collateralToken, m.oracle, m.irm, m.lltv],
  );
  return keccak256(enc).toLowerCase() === id.toLowerCase();
}

export async function marketParams(chain: Chain, id: Hex, at: At): Promise<MarketParams | null> {
  const p = await ask<readonly [Hex, Hex, Hex, Hex, bigint]>(chain, `market ${id.slice(0, 10)} params`, MORPHO, morpho, "idToMarketParams", [id], at);
  if (p[4] === 0n || /^0x0+$/.test(p[2])) return null;
  return { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
}

export async function marketState(chain: Chain, id: Hex, at: At): Promise<MarketState> {
  const m = await ask<readonly bigint[]>(chain, `market ${id.slice(0, 10)} totals`, MORPHO, morpho, "market", [id], at);
  return { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] };
}

/** Per-second borrow rate (WAD) the market's rate model gives for these totals. Pure view: totals are ours to choose. */
export async function borrowRate(chain: Chain, m: MarketParams, s: MarketState, at: At): Promise<bigint> {
  if (/^0x0+$/.test(m.irm)) return 0n;
  return ask<bigint>(chain, "borrow rate", m.irm, morphoIrm, "borrowRateView", [{ ...m }, { ...s }], at);
}

/** Morpho's wTaylorCompounded: e^(x*n) - 1 to three terms, in WAD. */
export function taylor(x: bigint, n: bigint): bigint {
  const first = x * n;
  const second = (first * first) / (2n * WAD);
  const third = (second * first) / (3n * WAD);
  return first + second + third;
}

export interface MorphoRead {
  snap: Snapshot;
  params: MarketParams;
  state: MarketState;
  fixedTerms: boolean;
  /** Debt with interest accrued to the block's timestamp, raw loan units. */
  debtRaw: bigint;
  collateralRaw: bigint;
  price: bigint;
}

export async function readMorpho(chain: Chain, id: Hex, wallet: Hex, at: number, samples: Sample[]): Promise<MorphoRead | null> {
  const params = await marketParams(chain, id, at);
  if (!params) return null;
  const pos = await ask<readonly [bigint, bigint, bigint]>(chain, "position", MORPHO, morpho, "position", [id, wallet], at);
  if (pos[1] === 0n) return null;
  const [state, time, price, loan, coll] = await Promise.all([
    marketState(chain, id, at),
    chain.timestamp(at),
    ask<bigint>(chain, "oracle price", params.oracle, morphoOracle, "price", [], at),
    tokenInfo(chain, params.loanToken),
    tokenInfo(chain, params.collateralToken),
  ]);
  const rate = await borrowRate(chain, params, state, at);
  const elapsed = BigInt(Math.max(0, time - Number(state.lastUpdate)));
  const interest = (state.totalBorrowAssets * taylor(rate, elapsed)) / WAD;
  const accrued: MarketState = { ...state, totalBorrowAssets: state.totalBorrowAssets + interest, totalSupplyAssets: state.totalSupplyAssets + interest };
  // toAssetsUp with Morpho's virtual shares (1e6) and virtual assets (1): what the borrower would have to repay.
  const debtRaw = (pos[1] * (accrued.totalBorrowAssets + 1n) + (accrued.totalBorrowShares + 10n ** 6n) - 1n) / (accrued.totalBorrowShares + 10n ** 6n);
  const collateralRaw = pos[2];
  const maxBorrow = (((collateralRaw * price) / 10n ** 36n) * params.lltv) / WAD;
  // "Every spare unit withdrawn": supply shrinks to what's borrowed, the rate model answers for 100% use.
  const stressed = await borrowRate(chain, params, { ...accrued, totalSupplyAssets: accrued.totalBorrowAssets }, at);
  const history = await Promise.all(
    samples.map(async (s) => ({ time: s.time, price: Number(await ask<bigint>(chain, "past oracle price", params.oracle, morphoOracle, "price", [], s.block).catch(() => 0n)) })),
  );
  const shape = priceShape(history.filter((h) => h.price > 0));
  const loanUnit = 10 ** loan.decimals;
  const snap: Snapshot = {
    kind: "morpho",
    venue: `Morpho ${coll.symbol}/${loan.symbol}`,
    where: id,
    wallet,
    block: at,
    time,
    quote: loan.symbol,
    hf: Number((maxBorrow * 10n ** 12n) / (debtRaw === 0n ? 1n : debtRaw)) / 1e12,
    collateral: [{
      token: params.collateralToken, ...coll, amount: collateralRaw,
      value: Number((collateralRaw * price) / 10n ** 36n) / loanUnit,
      lt: Number(params.lltv) / 1e18, apr: 0, priceShape: shape.shape, trendApr: shape.trendApr,
    }],
    debt: [{
      token: params.loanToken, ...loan, amount: debtRaw, value: Number(debtRaw) / loanUnit, lt: 0,
      apr: (Number(rate) * YEAR) / 1e18, stressApr: (Number(stressed) * YEAR) / 1e18, priceShape: "flat", trendApr: 0,
    }],
  };
  return { snap, params, state, fixedTerms: idMatchesParams(id, params), debtRaw, collateralRaw, price };
}
