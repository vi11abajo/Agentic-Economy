// The tokens knock will move by symbol. It's the Pacific Mainnet table from the Pharos docs, nothing more: a symbol
// is just a string anyone can deploy (there are two "APC3M" and two "APT" live on Pharos right now), so anything
// off this list has to come with its contract address and gets read from chain instead of trusted.
import type { Hex } from "viem";

export const PHAROS_CHAIN_ID = 1672;
export const DOCS_REGISTRY = "https://docs.pharos.xyz/getting-started/token-registry";

export interface Token {
  symbol: string;
  address: Hex | "native";
  decimals: number;
  /** Where we got it from, so the summary can say so. */
  source: string;
}

export const REGISTRY: Token[] = [
  { symbol: "PROS", address: "native", decimals: 18, source: "native coin of Pharos" },
  { symbol: "WPROS", address: "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0", decimals: 18, source: DOCS_REGISTRY },
  { symbol: "USDC", address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", decimals: 6, source: DOCS_REGISTRY },
  { symbol: "LINK", address: "0x51e2A24742Db77604B881d6781Ee16B5b8fcBE29", decimals: 18, source: DOCS_REGISTRY },
  { symbol: "WETH", address: "0x1f4b7011Ee3d53969bb67F59428a9ec0477856E9", decimals: 18, source: DOCS_REGISTRY },
];

// People still type the testnet-era name for the coin.
const NICKNAMES: Record<string, string> = { PHRS: "PROS" };

export function findBySymbol(s: string): Token | undefined {
  const wanted = s.trim().toUpperCase();
  const real = NICKNAMES[wanted] ?? wanted;
  return REGISTRY.find((t) => t.symbol === real);
}

export const USDC = findBySymbol("USDC")!;
export const WPROS = findBySymbol("WPROS")!;
