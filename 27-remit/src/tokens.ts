import type { Hex } from "viem";
import type { TokenInfo } from "./types.js";

export const PHAROS_CHAIN_ID = 1672;
export const PHAROS_RPC = process.env.PHAROS_RPC || "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

// The only three things remit will pay in. Addresses were read back from the chain (symbol + decimals) before they
// went in here; chain.ts checks them again on every plan, so a typo can't quietly send a transfer() into the void.
export const CANONICAL_TOKENS: Record<"PROS" | "WPROS" | "USDC", TokenInfo> = {
  PROS: { symbol: "PROS", name: "Pharos (native)", decimals: 18, isNative: true },
  WPROS: { symbol: "WPROS", name: "Wrapped PROS", address: "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0", decimals: 18, isNative: false },
  USDC: { symbol: "USDC", name: "USD Coin", address: "0xc879c018db60520f4355c26ed1a6d572cdac1815", decimals: 6, isNative: false },
};

/**
 * Addresses whose private keys everyone has: the ten default accounts of the Hardhat / Anvil / Foundry test
 * mnemonic ("test test ... junk"). Bots sweep anything that lands on them within seconds, so an invoice asking you
 * to pay one is either a copy-pasted tutorial or a trap. Either way it's a stop, not a warning.
 */
export const PUBLIC_DEV_KEYS: ReadonlySet<string> = new Set(
  [
    "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
    "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
    "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
    "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
    "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65",
    "0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc",
    "0x976EA74026E726554dB657fA54763abd0C3a0aa9",
    "0x14dC79964da2C08b23698B3D3cc7Ca32193d9955",
    "0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f",
    "0xa0Ee7A142d267C1f36714E4a8F75612F20a79720",
  ].map((a) => a.toLowerCase()),
);

export type TokenLookup = { token?: TokenInfo; error?: "ambiguous" | "unsupported" | "missing" };

/**
 * Turns what the invoice wrote into one of our three tokens. Deliberately narrow: "USD" or "$" could mean USDC,
 * a bridged USDC, a bank wire or a Stripe link, so we refuse to pick. Same for anything we don't list.
 */
export function resolveToken(raw?: string): TokenLookup {
  if (!raw || !raw.trim()) return { error: "missing" };
  const said = raw.trim().toUpperCase();
  if (said === "PROS") return { token: CANONICAL_TOKENS.PROS };
  if (said === "USDC") return { token: CANONICAL_TOKENS.USDC };
  if (said === "WPROS") return { token: CANONICAL_TOKENS.WPROS };
  if (["$", "USD", "US$", "DOLLAR", "DOLLARS", "BUCKS", "STABLE", "STABLECOIN"].includes(said)) return { error: "ambiguous" };
  return { error: "unsupported" };
}

/** Same, but for a QR code that names the token by contract address. */
export function tokenByAddress(address: string): TokenInfo | undefined {
  const lower = address.toLowerCase();
  return Object.values(CANONICAL_TOKENS).find((t) => t.address?.toLowerCase() === lower);
}

export const txLink = (hash: Hex | string) => `${EXPLORER}/tx/${hash}`;
export const addressLink = (a: Hex | string) => `${EXPLORER}/address/${a}`;
