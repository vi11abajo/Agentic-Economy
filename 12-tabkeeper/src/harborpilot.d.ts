// The parts of harborpilot (11-harborpilot, built to dist/ without .d.ts) that the Harbor data seller reuses.
declare module "harborpilot/dist/chain.js" {
  import type { PublicClient } from "viem";
  export function rpcRequest(url: string, maxInFlight?: number): (req: { method: string; params?: unknown }) => Promise<unknown>;
  export function makeClient(url?: string): PublicClient;
  export function pinnedBlock(client: PublicClient): Promise<{ block: bigint; time: bigint }>;
  export function blocksAgo(client: PublicClient, now: { block: bigint; time: bigint }, days: number[]): Promise<Map<number, { block: bigint; time: bigint }>>;
  export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T>;
}

declare module "harborpilot/dist/venues.js" {
  import type { Address } from "viem";
  export interface Venue {
    id: string;
    name: string;
    protocol: string;
    kind: string;
    address: Address;
    harbor: { min: string; liquidity: string; access: string; regions: string; apy: string; tvl: string; url?: string };
  }
  export const VENUES: Venue[];
}

declare module "harborpilot/dist/adapters.js" {
  import type { Address, PublicClient } from "viem";
  import type { Venue } from "harborpilot/dist/venues.js";
  export interface Ctx {
    client: PublicClient;
    block: bigint;
    time: bigint;
    past: Map<number, { block: bigint; time: bigint }>;
  }
  export interface Quote {
    venue: Venue;
    status: "open" | "closed" | "down";
    reason?: string;
    decimals: number;
    tvl?: number;
    apy: { d7?: number; d30?: number };
    minDeposit?: number;
    exitDays?: number;
    exitHow: string;
    exitFeePct: number;
    exitLiquidity?: number;
    asyncDeposit: boolean;
    notes: string[];
  }
  export interface Position {
    venue: Venue;
    shares: bigint;
    shareDecimals: number;
    assets: number;
    pendingDeposit?: number;
    claimableDeposit?: number;
    pendingRedeem?: number;
    claimableRedeem?: number;
  }
  export function position(ctx: Ctx, v: Venue, user: Address, requestIds?: bigint[]): Promise<Position>;
}

declare module "harborpilot/dist/cli.js" {
  import type { Address } from "viem";
  import type { Ctx, Quote } from "harborpilot/dist/adapters.js";
  export const PROBE: Address;
  export function quoteAll(ctx: Ctx, from: Address, amount: bigint, s: { venue_timeout_ms: number }): Promise<Quote[]>;
}

declare module "harborpilot/dist/router.js" {
  import type { Quote } from "harborpilot/dist/adapters.js";
  export interface Conditions {
    amount: number;
    maxExitDays?: number;
    allowAsyncDeposit: boolean;
    stableOnly: boolean;
    horizonDays: number;
    region?: string;
  }
  export function rankedApy(q: Quote): number | undefined;
  export function route(
    qs: Quote[],
    c: Conditions,
  ): { ranked: { quote: Quote; apy: number; net: number }[]; excluded: { quote: Quote; why: string }[]; down: { quote: Quote; why: string }[]; explanation: string[] };
}

declare module "harborpilot/dist/morpho.js" {
  import type { Address } from "viem";
  import type { Ctx } from "harborpilot/dist/adapters.js";
  export interface MarketState {
    price: number;
    lltv: number;
    borrowApy: number;
    supplyApy: number;
    free: number;
  }
  export function marketState(ctx: Ctx): Promise<MarketState>;
  export function loanOf(ctx: Ctx, s: MarketState, user: Address): Promise<{ collateral: bigint; borrowShares: bigint; debt: bigint; ltv: number; liquidationPrice: number }>;
}
