// Every place dent will consider putting money, with the facts we checked on chain before writing them down
// (2026-11-06, rpc.pharos.xyz). Anything that moves (rates, cash, open/closed) is read live; only identities live here.
import type { Hex } from "viem";

export type Lane = "USDC" | "PROS";
export type Kind = "idle" | "aave" | "vault" | "stpros" | "faroo-vault";

export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
export const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";
export const STPROS = "0x6b0a44c64190279f7034b77c13a566e914fe5ec4";
/** Chainlink PROS/USD, 18 decimals. Only used to put a dollar figure on gas in the USDC lane. */
export const PROS_USD_FEED = "0x371ed36aee5bffbed1a2aa9b7ded7f4eb30f5466";

export interface Source {
  id: string;
  name: string;
  protocol: string;
  lane: Lane;
  kind: Kind;
  /** Pool for Aave forks, the vault itself for ERC-4626, nothing for idle money. */
  address?: string;
  /** The token that goes in: USDC, WPROS, native PROS (idle / stPROS) or stPROS (Faroo vaults). */
  asset: string;
  note?: string;
}

export const LANE_DECIMALS: Record<Lane, number> = { USDC: 6, PROS: 18 };

export const SOURCES: Source[] = [
  { id: "wallet-usdc", name: "USDC left in the wallet", protocol: "-", lane: "USDC", kind: "idle", asset: USDC },
  {
    id: "avalon-usdc",
    name: "Avalon main pool, USDC",
    protocol: "Avalon (Aave V3 fork)",
    lane: "USDC",
    kind: "aave",
    address: "0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa",
    asset: USDC,
  },
  {
    id: "openfi-usdc",
    name: "OpenFi, USDC",
    protocol: "OpenFi (Aave V3 fork)",
    lane: "USDC",
    kind: "aave",
    address: "0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26",
    asset: USDC,
  },
  {
    id: "zona-usdc",
    name: "Zona, USDC",
    protocol: "Zona (Aave V3 fork)",
    lane: "USDC",
    kind: "aave",
    address: "0xda464e68208a3083eb65fe5c522a72aed1c1372a",
    asset: USDC,
  },
  {
    id: "rockawayx-usdc",
    name: "RockawayX USDC vault",
    protocol: "Morpho Vault V2 (ERC-4626)",
    lane: "USDC",
    kind: "vault",
    address: "0x047cd0a91e9b92ed979189a6c8a120bf280f02e5",
    asset: USDC,
    note: "a vault spreads deposits over Morpho markets; how much your deposit lowers its rate is not modelled",
  },
  { id: "wallet-pros", name: "PROS left in the wallet", protocol: "-", lane: "PROS", kind: "idle", asset: "native" },
  {
    id: "faroo-stpros",
    name: "Faroo stPROS (liquid staking)",
    protocol: "Faroo (Bifrost SLPx)",
    lane: "PROS",
    kind: "stpros",
    address: STPROS,
    asset: "native",
    note: "leaving is redeem, a one-day unbonding wait, then a claim",
  },
  {
    id: "openfi-wpros",
    name: "OpenFi, WPROS",
    protocol: "OpenFi (Aave V3 fork)",
    lane: "PROS",
    kind: "aave",
    address: "0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26",
    asset: WPROS,
  },
  {
    id: "zona-wpros",
    name: "Zona, WPROS",
    protocol: "Zona (Aave V3 fork)",
    lane: "PROS",
    kind: "aave",
    address: "0xda464e68208a3083eb65fe5c522a72aed1c1372a",
    asset: WPROS,
  },
  {
    id: "avalon-inno-wpros",
    name: "Avalon innovative pool, WPROS",
    protocol: "Avalon (Aave V3 fork)",
    lane: "PROS",
    kind: "aave",
    address: "0xdef0EB584700Fc81C73ACcd555cB6cea5FB85C3e",
    asset: WPROS,
  },
  {
    id: "faroo-frhv001",
    name: "Faroo RWA Hybrid Vault 001",
    protocol: "Faroo",
    lane: "PROS",
    kind: "faroo-vault",
    address: "0x36f3d19dda7ed1428e3014ae6f2a75d70393b7e6",
    asset: STPROS,
  },
  {
    id: "faroo-fyv001",
    name: "Faroo Yield Vault 001",
    protocol: "Faroo",
    lane: "PROS",
    kind: "faroo-vault",
    address: "0xc775dfaa7565f2aca5ddf5dd6837ceb846de591b",
    asset: STPROS,
  },
];

/**
 * Where each token keeps its balances and allowances, so a simulation can hand a wallet money it doesn't have
 * yet. Found by matching storage against balanceOf on chain.
 */
export const TOKEN_SLOTS: Record<string, { kind: "solidity"; balance: bigint; allowance: bigint } | { kind: "erc7201"; base: Hex }> = {
  [USDC]: { kind: "solidity", balance: 9n, allowance: 10n },
  [WPROS]: { kind: "solidity", balance: 3n, allowance: 4n },
  // OpenZeppelin upgradeable ERC20 namespace; allowances sit one slot after balances.
  [STPROS]: { kind: "erc7201", base: "0x52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00" },
};

/** Gas a stPROS claim used in recent real claims (explorer, 2026-11-03..06: 83,967 to 150,493). It can't be simulated before the redeem exists. */
export const STPROS_CLAIM_GAS_OBSERVED = 150_493n;

export function sourceById(id: string): Source {
  const s = SOURCES.find((x) => x.id === id);
  if (!s) throw new Error(`unknown source "${id}". Known: ${SOURCES.map((x) => x.id).join(", ")}`);
  return s;
}
