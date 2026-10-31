// The 16 assets listed on Pharos Harbor (port.pharos.xyz/harbor), each mapped to its contract on Pharos.
// Whether a venue takes deposits is never taken from this file: it is decided live by simulating the deposit.
// The `harbor` block is what Harbor itself says about the asset (read from its API on 2026-10-31); the router
// uses it only where the chain can't tell (redemption schedule, KYB, regions).
import type { Address } from "viem";
import { USDC } from "./chain.js";

/**
 * How to talk to the contract:
 * - vault-v2: Morpho Vault V2 (ERC-4626), deposit and withdraw at once, limited by the vault's liquidity
 * - r25-sync: R25 ERC-4626 vault, deposit at once, shares unlock after maturityPeriod, daily withdraw quota
 * - r25-async: R25 vault, deposit at once, exit by requestRedeem that the operator fulfils
 * - full-async: ERC-7540, both deposit and redeem are requests
 * - accountable: Accountable vault, deposit at once, exit by requestRedeem
 * - epoch: R25 vault that opens deposits per epoch
 * - ember: Ember vault, deposit, exit by redeemShares
 * - centrifuge: Centrifuge ERC-7540 share class, members only
 * - token-only: the asset exists on Pharos only as a token; deposits happen elsewhere
 */
export type Kind = "vault-v2" | "r25-sync" | "r25-async" | "full-async" | "accountable" | "epoch" | "ember" | "centrifuge" | "token-only";

export interface Venue {
  id: string;
  harborId: string;
  name: string;
  protocol: string;
  kind: Kind;
  /** The contract you deposit into (for token-only: the token). */
  address: Address;
  /** The share token, when it is not the vault itself. */
  share?: Address;
  asset?: Address;
  /** Exit by request: days until paid out, per Harbor's schedule (the chain doesn't state it). */
  requestDays?: number;
  harbor: { min: string; liquidity: string; access: string; regions: string; apy: string; tvl: string; url?: string };
  /** For token-only assets: what was found on Pharos. */
  why?: string;
}

export const MORPHO: Address = "0x18573fA18fd17dDfD790B4a5B5b2977aad3b4Efb";

export const VENUES: Venue[] = [
  {
    id: "roxusdc",
    harborId: "RockawayX-USDC",
    name: "RockawayX USDC (roxUSDC)",
    protocol: "Morpho Vault V2",
    kind: "vault-v2",
    address: "0x047cd0a91e9b92ed979189a6c8a120bf280f02e5",
    asset: USDC,
    harbor: { min: "1 USD", liquidity: "On-demand", access: "Permissionless", regions: "-", apy: "Target 8.5%", tvl: "11.18M", url: "https://go.oku.trade/pharosVault" },
  },
  {
    id: "sharpbyte",
    harborId: "SharpByte-USDC",
    name: "SharpByte USDC Pharos Ecosystem",
    protocol: "Morpho Vault V2",
    kind: "vault-v2",
    address: "0x15c25ed222fc498f672af5c3adb5ed0a96e1aff1",
    asset: USDC,
    harbor: { min: "0", liquidity: "On-demand", access: "Permissionless", regions: "not for US", apy: "14.18%", tvl: "2.25M", url: "https://oku.trade/morpho/analytics?chainId=1672&vaultId=0x15c25ed222fc498f672af5c3adb5ed0a96e1aff1" },
  },
  {
    id: "vrpcw",
    harborId: "VRPC-Daily",
    name: "Axil Consumer Credit 1D (VRPC-Weekly)",
    protocol: "R25",
    kind: "r25-sync",
    address: "0x1c2bc8b553d9a7e61f7531a3a4bf2162f4569268",
    asset: USDC,
    harbor: { min: "1 USD", liquidity: "Daily", access: "Permissionless", regions: "not for CN", apy: "8%", tvl: "2.19M", url: "https://app.r25.xyz/vaults/VRPCW" },
  },
  {
    id: "vrpcs",
    harborId: "VRPC-SemiYearly",
    name: "Axil Consumer Credit 6M (VRPC-SemiYearly)",
    protocol: "R25",
    kind: "r25-async",
    address: "0xee26bb0989691735c997dfdc49a4a607f75e190b",
    asset: USDC,
    harbor: { min: "100 USD", liquidity: "Semi-Yearly", access: "Permissionless", regions: "not for CN", apy: "15%", tvl: "9.91M", url: "https://app.r25.xyz/vaults/VRPCS" },
  },
  {
    id: "axilpot",
    harborId: "Axil-Pot",
    name: "Axil Pot (APT)",
    protocol: "R25",
    kind: "r25-async",
    address: "0x921974d7b1a2dbaccaf5ba893a3a1500638cea6b",
    share: "0x13282289b8B241Cf16eB5B8Bad401C7c2fdAb0F8",
    asset: USDC,
    requestDays: 0,
    harbor: { min: "1 USD", liquidity: "Flexible, withdraw fee T+0 0.15%, T+7 0.10%", access: "-", regions: "-", apy: "9%", tvl: "12.12M", url: "https://app.r25.xyz/vaults/APT" },
  },
  {
    id: "prnh",
    harborId: "pRNH",
    name: "Raffaello NYLIM HYB (pRNH)",
    protocol: "R25",
    kind: "full-async",
    address: "0x6Ce4bc043398Ac40392d1E063328048072b2075d",
    asset: USDC,
    requestDays: 1,
    harbor: { min: "1 USD", liquidity: "Daily", access: "Permissionless", regions: "Europe mainly", apy: "Target 7%", tvl: "0.099M", url: "https://app.r25.xyz/vaults/pRNH" },
  },
  {
    id: "pgain",
    harborId: "pGAIN",
    name: "Pelican pGAIN",
    protocol: "Accountable",
    kind: "accountable",
    address: "0xe4EE0fe4B09021FCdF76B165AA1e8eAF7d447c35",
    asset: USDC,
    requestDays: 7,
    harbor: { min: "100 USD", liquidity: "Weekly", access: "Permissionless", regions: "not for OFAC-sanctioned", apy: "10.1%", tvl: "3.98M", url: "https://yield.accountable.capital/vaults/1672/0x27b0b7Acd42D5C91db91446605770D3D3c338a42" },
  },
  {
    id: "apc3m",
    harborId: "APC3M",
    name: "Axil Prime 3M (APC3M)",
    protocol: "R25",
    kind: "epoch",
    address: "0xd0428799fbc35557834d33121ba4472692c8908a",
    share: "0xEC47E6f3EF1E7bc8e00F670aC3d5016798Fe44d0",
    asset: USDC,
    harbor: { min: "2 USD", liquidity: "-", access: "-", regions: "-", apy: "13.8%", tvl: "72.77M" },
  },
  {
    id: "palpha",
    harborId: "pALPHA",
    name: "Pharos RealFi Vault (pALPHA)",
    protocol: "Ember",
    kind: "ember",
    address: "0xE47E9bA4EA2320A6ed87246d02Fd5C38485Ed7d1",
    asset: USDC,
    harbor: { min: "0.1 USD", liquidity: "-", access: "-", regions: "-", apy: "13.8%", tvl: "6.63M", url: "https://port.pharos.xyz/deposit/" },
  },
  {
    id: "tulprwa",
    harborId: "tulPRWA",
    name: "TulipaPRWA",
    protocol: "Ember",
    kind: "ember",
    address: "0xBae9272F71Db2Dc9D053E3C6c4840dF65ae6aeC5",
    asset: USDC,
    harbor: { min: "1 USD", liquidity: "On-demand", access: "Permissionless", regions: "-", apy: "Target 14%", tvl: "1.64M", url: "https://ember.so/earn/tulPRWA" },
  },
  {
    id: "gpci",
    harborId: "GPCI",
    name: "Goblin Private Credit I (GPCI)",
    protocol: "Ember",
    kind: "ember",
    address: "0x8360648fbA018EE2676C2A13df2ea5BB9b2bD847",
    asset: USDC,
    harbor: { min: "0", liquidity: "Quarterly", access: "KYB required", regions: "-", apy: "12%", tvl: "106", url: "https://ember.so/earn/GPCI" },
  },
  {
    id: "zsmb",
    harborId: "zSMB",
    name: "Zivoe SMB Credit (zSMB)",
    protocol: "Centrifuge",
    kind: "centrifuge",
    address: "0x63d2b3596510b95cf02d921f21bac19d31c9a4c6",
    share: "0x49C8919162daE24468965557C9344bA2aa8121b8",
    asset: USDC,
    harbor: { min: "0 USD", liquidity: "On-demand", access: "KYB required", regions: "not for OFAC-sanctioned", apy: "Target 14%", tvl: "1.00M", url: "https://app.zivoe.com/vaults/zivoe-smb-credit" },
  },
  {
    id: "ethvp",
    harborId: "ETHvp",
    name: "Vishwa ETHvp",
    protocol: "Vishwa",
    kind: "token-only",
    address: "0xDe0Ed48021050a4979068A1708f6BbfB3939f385",
    why: "on Pharos only a token its minter issues; no deposit contract here",
    harbor: { min: "10 ETH", liquidity: "On-demand", access: "Permissionless", regions: "not for CN", apy: "Target 30%", tvl: "24.33M", url: "https://vault.vishwalab.com/ethvp" },
  },
  {
    id: "btcvc",
    harborId: "BTCvc",
    name: "Vishwa BTCvc",
    protocol: "Vishwa",
    kind: "token-only",
    address: "0x4b01436d82dFF601281F7ebdF44e73a47d77Ee3D",
    why: "on Pharos only a token its minter issues; no deposit contract here",
    harbor: { min: "10000 USD", liquidity: "On-demand", access: "KYB required", regions: "not for CN", apy: "4%", tvl: "44.08M", url: "https://vault.vishwalab.com/btcvc" },
  },
  {
    id: "btcvp",
    harborId: "BTCvp",
    name: "Vishwa BTCvp",
    protocol: "Vishwa",
    kind: "token-only",
    address: "0x0000000000000000000000000000000000000000",
    why: "no contract for it found on Pharos",
    harbor: { min: "10000 USD", liquidity: "60-day notice", access: "KYB required", regions: "not for CN", apy: "5%", tvl: "3.87M", url: "https://vault.vishwalab.com/btcvp" },
  },
  {
    id: "bfbtc",
    harborId: "bfBTC",
    name: "BitFi bfBTC",
    protocol: "BitFi",
    kind: "token-only",
    address: "0x623F2774d9f27B59bc6b954544487532CE79d9DF",
    why: "the Pharos contract has no underlying asset set (underlyingAsset() = 0x0), so nothing can be deposited here",
    harbor: { min: "10 USD", liquidity: "Daily", access: "Permissionless", regions: "not for US", apy: "6.74%", tvl: "28.50M", url: "https://app.bitfi.one/bfbtc/stake" },
  },
];

export function findVenue(id: string): Venue | undefined {
  const k = id.toLowerCase();
  return VENUES.find((v) => v.id === k || v.harborId.toLowerCase() === k || v.address.toLowerCase() === k);
}
