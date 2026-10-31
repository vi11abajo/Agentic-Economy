// Borrowing USDC against PROS on Morpho Blue, in the USDC / WPROS market that roxUSDC lends into. PROS is
// wrapped to WPROS, posted as collateral, and USDC is borrowed against it; repay does it backwards.
import { encodeFunctionData, formatUnits, parseAbi, type Address, type Hex } from "viem";
import { WPROS, USDC, type Step } from "./chain.js";
import { ERC20, type Ctx } from "./adapters.js";
import { MORPHO } from "./venues.js";

export const WPROS_MARKET: Hex = "0xb3b8a31c8a1652cf31eb872c7778716edc39471ed82bcad99b3f5c83a449e1ba";

const MP = "(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)";
export const BLUE = parseAbi([
  `function idToMarketParams(bytes32) view returns ${MP}`,
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
  "function position(bytes32, address) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)",
  `function supplyCollateral(${MP} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${MP} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${MP} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdrawCollateral(${MP} marketParams, uint256 assets, address onBehalf, address receiver)`,
]);
const ORACLE = parseAbi(["function price() view returns (uint256)"]);
const IRM = parseAbi([`function borrowRateView(${MP} marketParams, (uint128,uint128,uint128,uint128,uint128,uint128) market) view returns (uint256)`]);
const WETH = parseAbi(["function deposit() payable", "function withdraw(uint256)"]);

export type MarketParams = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };

export interface MarketState {
  params: MarketParams;
  /** USDC per 1 WPROS. */
  price: number;
  /** Raw oracle price (scaled 1e36 x loan decimals / collateral decimals). */
  priceRaw: bigint;
  lltv: number;
  borrowApy: number;
  supplyApy: number;
  free: number;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
}

export interface Loan {
  collateral: bigint;
  borrowShares: bigint;
  /** USDC owed now, rounded up. */
  debt: bigint;
  /** debt / (collateral x price). */
  ltv: number;
  /** The WPROS price at which this loan can be liquidated. */
  liquidationPrice: number;
}

export async function marketState(ctx: Ctx): Promise<MarketState> {
  const c = ctx.client;
  const p = (await c.readContract({ address: MORPHO, abi: BLUE, functionName: "idToMarketParams", args: [WPROS_MARKET], blockNumber: ctx.block })) as readonly [Address, Address, Address, Address, bigint];
  const params: MarketParams = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  const m = (await c.readContract({ address: MORPHO, abi: BLUE, functionName: "market", args: [WPROS_MARKET], blockNumber: ctx.block })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const priceRaw = (await c.readContract({ address: params.oracle, abi: ORACLE, functionName: "price", blockNumber: ctx.block })) as bigint;
  const rate = (await c.readContract({ address: params.irm, abi: IRM, functionName: "borrowRateView", args: [params, m], blockNumber: ctx.block })) as bigint;
  const borrowApy = Math.expm1((Number(rate) / 1e18) * 365 * 86400);
  const util = m[0] ? Number(m[2]) / Number(m[0]) : 0;
  return {
    params,
    priceRaw,
    price: Number(priceRaw) / 1e36 * 1e12, // 1e36 * 10^(6-18)
    lltv: Number(params.lltv) / 1e18,
    borrowApy: borrowApy * 100,
    supplyApy: borrowApy * util * (1 - Number(m[5]) / 1e18) * 100,
    free: Number(formatUnits(m[0] - m[2], 6)),
    totalBorrowAssets: m[2],
    totalBorrowShares: m[3],
  };
}

export async function loanOf(ctx: Ctx, s: MarketState, user: Address): Promise<Loan> {
  const r = (await ctx.client.readContract({ address: MORPHO, abi: BLUE, functionName: "position", args: [WPROS_MARKET, user], blockNumber: ctx.block })) as readonly [bigint, bigint, bigint];
  const borrowShares = r[1];
  const collateral = r[2];
  // Morpho's toAssetsUp with its virtual shares (1e6) and virtual assets (1).
  const debt = borrowShares ? (borrowShares * (s.totalBorrowAssets + 1n) + (s.totalBorrowShares + 1_000_000n) - 1n) / (s.totalBorrowShares + 1_000_000n) : 0n;
  return { collateral, borrowShares, debt, ...health(collateral, debt, s) };
}

/** Loan-to-value and liquidation price for a collateral (WPROS wei) and a debt (USDC base units). */
export function health(collateral: bigint, debt: bigint, s: Pick<MarketState, "price" | "lltv">): { ltv: number; liquidationPrice: number } {
  const c = Number(formatUnits(collateral, 18));
  const d = Number(formatUnits(debt, 6));
  return { ltv: c ? d / (c * s.price) : d ? Infinity : 0, liquidationPrice: c ? d / (c * s.lltv) : 0 };
}

const mp = (p: MarketParams) => ({ loanToken: p.loanToken, collateralToken: p.collateralToken, oracle: p.oracle, irm: p.irm, lltv: p.lltv });

/** Wrap `pros` (wei) to WPROS, post it, borrow `usdc` (base units). Either part can be zero. */
export function borrowSteps(p: MarketParams, user: Address, pros: bigint, usdc: bigint): Step[] {
  const out: Step[] = [];
  if (pros) {
    out.push({ label: `wrap ${formatUnits(pros, 18)} PROS into WPROS`, to: WPROS, data: encodeFunctionData({ abi: WETH, functionName: "deposit" }), value: pros });
    out.push({ label: `approve ${formatUnits(pros, 18)} WPROS to Morpho`, to: WPROS, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [MORPHO, pros] }), value: 0n });
    out.push({ label: `post ${formatUnits(pros, 18)} WPROS as collateral`, to: MORPHO, data: encodeFunctionData({ abi: BLUE, functionName: "supplyCollateral", args: [mp(p), pros, user, "0x"] }), value: 0n });
  }
  if (usdc) {
    out.push({ label: `borrow ${formatUnits(usdc, 6)} USDC`, to: MORPHO, data: encodeFunctionData({ abi: BLUE, functionName: "borrow", args: [mp(p), usdc, 0n, user, user] }), value: 0n });
  }
  return out;
}

/** Repay the whole loan (by shares, so nothing is left over), take the collateral back and unwrap it. */
export function repaySteps(p: MarketParams, user: Address, loan: Loan): Step[] {
  const out: Step[] = [];
  if (loan.borrowShares) {
    const allowance = loan.debt + loan.debt / 1000n + 1n; // interest keeps accruing until the block it lands in
    out.push({ label: `approve ${formatUnits(allowance, 6)} USDC to Morpho`, to: USDC, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [MORPHO, allowance] }), value: 0n });
    out.push({ label: `repay the loan (about ${formatUnits(loan.debt, 6)} USDC)`, to: MORPHO, data: encodeFunctionData({ abi: BLUE, functionName: "repay", args: [mp(p), 0n, loan.borrowShares, user, "0x"] }), value: 0n });
  }
  if (loan.collateral) {
    out.push({ label: `take back ${formatUnits(loan.collateral, 18)} WPROS of collateral`, to: MORPHO, data: encodeFunctionData({ abi: BLUE, functionName: "withdrawCollateral", args: [mp(p), loan.collateral, user, user] }), value: 0n });
    out.push({ label: `unwrap ${formatUnits(loan.collateral, 18)} WPROS into PROS`, to: WPROS, data: encodeFunctionData({ abi: WETH, functionName: "withdraw", args: [loan.collateral] }), value: 0n });
  }
  return out;
}

