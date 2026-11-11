// Sign-in with Ethereum, the plain kind: the page asks for a nonce, your wallet signs a readable message (not a
// transaction, costs nothing), and we check the signature recovers your address. That address is the only thing
// a watch or a push channel is tied to. A nonce works once, for ten minutes, and only for this site on Pharos.
import { verifyMessage, type Address, type Hex } from "viem";
import { generateSiweNonce, parseSiweMessage, validateSiweMessage } from "viem/siwe";
import type { Store } from "./store.js";

export const SIWE_DOMAIN = process.env.PROSPERION_DOMAIN ?? "prosperion.pharosfdv.xyz";
export const SESSION_COOKIE = "ps_session";
export const SESSION_TTL_MS = 7 * 24 * 3600_000;
const NONCE_TTL_MS = 10 * 60_000;

export function newNonce(store: Store): string {
  const nonce = generateSiweNonce();
  store.putNonce(nonce);
  return nonce;
}

/** Returns the signer's address, or null if anything about the message or signature is off. */
export async function verifySiwe(store: Store, message: string, signature: Hex): Promise<Address | null> {
  let fields: ReturnType<typeof parseSiweMessage>;
  try {
    fields = parseSiweMessage(message);
  } catch {
    return null;
  }
  if (!fields.address || !fields.nonce) return null;
  if (fields.chainId !== 1672) return null;
  if (!validateSiweMessage({ message: fields, domain: SIWE_DOMAIN })) return null;
  // The wallets we target (OKX, Rabby, MetaMask) are plain accounts, so a local ecrecover is enough.
  const ok = await verifyMessage({ address: fields.address, message, signature }).catch(() => false);
  if (!ok) return null;
  // Burn the nonce only after the signature checks out, so a garbage request cannot use up someone's nonce.
  if (!store.takeNonce(fields.nonce, NONCE_TTL_MS)) return null;
  return fields.address;
}

export function sessionCookie(token: string): string {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}`;
}
