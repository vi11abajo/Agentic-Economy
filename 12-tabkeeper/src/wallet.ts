// The buyer's side of the chain: reading whether a payment's nonce is used, finding the transaction that used
// it, and signing payments. The buyer never sends a transaction itself: the seller's facilitator submits the
// signed authorization and pays the gas, so the buyer needs USDC and no PROS.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, custom, type Account, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { rpcRequest } from "harborpilot/dist/chain.js";
import type { Chain } from "./buyer.js";
import { EIP3009, NETWORK, RPC_URL, USDC } from "./pharos.js";

export function makeClient(url = RPC_URL): PublicClient {
  return createPublicClient({ transport: custom({ request: rpcRequest(url) }, { retryCount: 0 }) }) as PublicClient;
}

const LOG_WINDOW = 1000n; // the Pharos RPC answers eth_getLogs for at most 1000 blocks

export function chainOf(client: PublicClient): Chain {
  return {
    used: (from, nonce) => client.readContract({ address: USDC, abi: EIP3009, functionName: "authorizationState", args: [from as Hex, nonce as Hex] }),
    async findTx(from, nonce, fromBlock) {
      const head = await client.getBlockNumber();
      for (let start = fromBlock; start <= head; start += LOG_WINDOW) {
        const logs = await client.getLogs({
          address: USDC,
          event: EIP3009[2],
          args: { authorizer: from as Hex, nonce: nonce as Hex },
          fromBlock: start,
          toBlock: start + LOG_WINDOW - 1n > head ? head : start + LOG_WINDOW - 1n,
        });
        if (logs[0]) return logs[0].transactionHash;
      }
      return undefined;
    },
    head: () => client.getBlockNumber(),
  };
}

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** The paying key, from .env in the data folder (or TABKEEPER_ENV_FILE) or the environment. Never printed. */
export function account(home: string, env: NodeJS.ProcessEnv = process.env): Account | null {
  const file = env.TABKEEPER_ENV_FILE || join(home, ".env");
  const vars = { ...(existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {}), ...env } as Record<string, string | undefined>;
  const pk = vars.TABKEEPER_PRIVATE_KEY || vars.PRIVATE_KEY;
  if (!pk) return null;
  const hex = (pk.startsWith("0x") ? pk : `0x${pk}`) as Hex;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("PRIVATE_KEY in .env doesn't look like a 32-byte hex key");
  return privateKeyToAccount(hex);
}

/**
 * Signs with the x402 SDK's EIP-3009 scheme. The SDK's own spend control is set to the task's cap as a second
 * lock: even if a price got past our check, the SDK would refuse to sign it.
 */
export function signerFor(acct: Account, capAtomic: bigint) {
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(acct as never))
    .setSpendControls({ maxAmountPerPayment: false, allowedAssets: [{ network: NETWORK, asset: USDC, maxAmountPerPayment: capAtomic.toString() }] });
  return (required: PaymentRequired) => client.createPaymentPayload(required);
}
