// Morpho Blue lending markets, read straight from the singleton, and the RockawayX vault modelled from the
// markets it lends into. The rate-with-you trick is the same as for the Aave forks: hand the market's own
// interest-rate model the totals as they'd be with your money in, and read the answer.
import { encodeAbiParameters, keccak256, parseAbi, type Hex } from "viem";
import type { Reader } from "./reads.js";

export const MORPHO = "0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb";
const YEAR = 365 * 24 * 3600;
const WAD = 10n ** 18n;

export const morphoAbi = parseAbi([
  "function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)",
  "function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  "function supply((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)",
  "function withdraw((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)",
]);

export const irmAbi = parseAbi([
  "function borrowRateView((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee) market) view returns (uint256)",
]);

// Morpho Vault V2 and its Morpho-market adapter. Names checked against the RockawayX vault on 2026-11-06.
export const vaultV2Abi = parseAbi([
  "function liquidityAdapter() view returns (address)",
  "function liquidityData() view returns (bytes)",
  "function adaptersLength() view returns (uint256)",
  "function adapters(uint256) view returns (address)",
  "function performanceFee() view returns (uint96)",
  "function totalAssets() view returns (uint256)",
]);
export const adapterAbi = parseAbi([
  "function marketIdsLength() view returns (uint256)",
  "function marketIds(uint256) view returns (bytes32)",
  "function expectedSupplyAssets(bytes32 id) view returns (uint256)",
]);

export type MarketParams = { loanToken: Hex; collateralToken: Hex; oracle: Hex; irm: Hex; lltv: bigint };
export type MarketState = {
  totalSupplyAssets: bigint;
  totalSupplyShares: bigint;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  lastUpdate: bigint;
  fee: bigint;
};

export function marketId(mp: MarketParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [mp.loanToken, mp.collateralToken, mp.oracle, mp.irm, mp.lltv],
    ),
  );
}

export async function params(r: Reader, id: Hex, block: number): Promise<MarketParams> {
  const p = await r.read<readonly [Hex, Hex, Hex, Hex, bigint]>(`Morpho market ${id.slice(0, 10)}: params`, MORPHO, morphoAbi, "idToMarketParams", [id], block);
  return { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
}

export async function state(r: Reader, id: Hex, block: number): Promise<MarketState> {
  const m = await r.read<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(`Morpho market ${id.slice(0, 10)}: totals`, MORPHO, morphoAbi, "market", [id], block);
  return { totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] };
}

/** Supply rate (simple annual) the market pays with `added` more supplied, from its own rate model. */
export async function supplyRate(r: Reader, id: Hex, mp: MarketParams, m: MarketState, added: bigint, block: number): Promise<number> {
  const s = { ...m, totalSupplyAssets: m.totalSupplyAssets + added };
  if (s.totalSupplyAssets === 0n) return 0;
  const perSecond = await r.read<bigint>(
    `Morpho market ${id.slice(0, 10)}: borrow rate with ${added} more supplied`,
    mp.irm,
    irmAbi,
    "borrowRateView",
    [mp, s],
    block,
  );
  const borrowApr = Number(perSecond * BigInt(YEAR)) / 1e18;
  const utilisation = Number((s.totalBorrowAssets * 1_000_000n) / s.totalSupplyAssets) / 1_000_000;
  return borrowApr * utilisation * (1 - Number(m.fee) / 1e18);
}

/** Supply share price, scaled by 1e18, for realised-rate windows. Moves only when someone touches the market. */
export function sharePrice(m: MarketState): bigint {
  return m.totalSupplyShares === 0n ? 0n : (m.totalSupplyAssets * WAD * 10n ** 6n) / m.totalSupplyShares;
}

/**
 * The vault's rate if `added` more went in now: what each market it lends into pays, weighted by how much it
 * has there, after its performance fee, over its total assets. New money goes to the liquidity market.
 */
export async function vaultV2Model(r: Reader, vault: string, added: bigint, block: number): Promise<{ now: number; withYou: number; idleShare: number; markets: number }> {
  const [liqAdapter, liqData, fee, total, nAdapters] = await Promise.all([
    r.read<Hex>("RockawayX: liquidity adapter", vault, vaultV2Abi, "liquidityAdapter", [], block),
    r.read<Hex>("RockawayX: liquidity market", vault, vaultV2Abi, "liquidityData", [], block),
    r.read<bigint>("RockawayX: performance fee", vault, vaultV2Abi, "performanceFee", [], block),
    r.read<bigint>("RockawayX: total assets", vault, vaultV2Abi, "totalAssets", [], block),
    r.read<bigint>("RockawayX: adapter count", vault, vaultV2Abi, "adaptersLength", [], block),
  ]);
  const w = (i: number) => BigInt(`0x${liqData.slice(2 + 64 * i, 2 + 64 * (i + 1))}`);
  // liquidityData decodes to abi.encode(MarketParams): five words.
  const liqMp: MarketParams = {
    loanToken: `0x${w(0).toString(16).padStart(40, "0")}`,
    collateralToken: `0x${w(1).toString(16).padStart(40, "0")}`,
    oracle: `0x${w(2).toString(16).padStart(40, "0")}`,
    irm: `0x${w(3).toString(16).padStart(40, "0")}`,
    lltv: w(4),
  };
  const liqId = marketId(liqMp);
  let earnNow = 0;
  let earnWith = 0;
  let placed = 0n;
  let markets = 0;
  let sawLiquidityMarket = false;
  for (let i = 0n; i < nAdapters; i++) {
    const ad = await r.read<Hex>("RockawayX: adapter", vault, vaultV2Abi, "adapters", [i], block);
    const n = await r.read<bigint>("RockawayX: markets in adapter", ad, adapterAbi, "marketIdsLength", [], block);
    for (let k = 0n; k < n; k++) {
      const id = await r.read<Hex>("RockawayX: market id", ad, adapterAbi, "marketIds", [k], block);
      const assets = await r.read<bigint>(`RockawayX: lent into ${id.slice(0, 10)}`, ad, adapterAbi, "expectedSupplyAssets", [id], block);
      if (assets === 0n) continue;
      markets++;
      const mp = await params(r, id, block);
      const m = await state(r, id, block);
      const rate = await supplyRate(r, id, mp, m, 0n, block);
      const a = Number(assets);
      placed += assets;
      earnNow += a * rate;
      if (ad.toLowerCase() === liqAdapter.toLowerCase() && id === liqId) {
        sawLiquidityMarket = true;
        const rateWith = await supplyRate(r, id, mp, m, added, block);
        earnWith += (a + Number(added)) * rateWith;
      } else earnWith += a * rate;
    }
  }
  if (!sawLiquidityMarket && added > 0n) {
    const mp = await params(r, liqId, block);
    const m = await state(r, liqId, block);
    earnWith += Number(added) * (await supplyRate(r, liqId, mp, m, added, block));
  }
  const keep = 1 - Number(fee) / 1e18;
  return {
    now: total > 0n ? (earnNow * keep) / Number(total) : 0,
    withYou: (earnWith * keep) / Number(total + added),
    idleShare: total > 0n ? 1 - Number(placed) / Number(total) : 0,
    markets,
  };
}
