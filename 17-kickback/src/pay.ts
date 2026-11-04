// Signing happens here, on this machine, with the key from .env. Sending goes through the Chain MCP
// (send_raw_transaction), and a payout only counts once its receipt shows the money actually moved.
import { encodeFunctionData, keccak256, pad, type Address, type Hex, type LocalAccount } from "viem";
import type { Chain, Receipt, TxInfo } from "./chain.js";
import type { Token } from "./params.js";

export const PHAROS_CHAIN_ID = 1672;
export const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815" as Address;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

export type Sleep = (ms: number) => Promise<void>;
export const realSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function usdcTransfer(to: Address, amount: bigint): Hex {
  return encodeFunctionData({
    abi: [{ type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] }],
    functionName: "transfer",
    args: [to, amount],
  });
}

/**
 * Builds and signs one transaction with fresh nonce, gas price and a 20% gas margin over the estimate.
 * Throws RevertedCall if the estimate says it would revert, before anything is signed.
 * `minNonce` is the lowest nonce we know is still free: a node a block behind can report a nonce we already used.
 */
export async function signTx(chain: Chain, account: LocalAccount, tx: { to: Address; data?: Hex; value?: bigint }, minNonce = 0): Promise<{ raw: Hex; hash: Hex }> {
  const from = account.address;
  const estimate = await chain.estimateGas({ from, to: tx.to, data: tx.data, value: tx.value });
  const nonce = Math.max(await chain.nonce(from), minNonce);
  const gasPrice = await chain.gasPrice();
  const raw = await account.signTransaction!({
    type: "legacy",
    chainId: PHAROS_CHAIN_ID,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
    nonce,
    gas: (estimate * 12n) / 10n,
    gasPrice,
  });
  return { raw, hash: keccak256(raw) };
}

/**
 * Sends a signed tx and waits for its receipt. Sending the same bytes twice is harmless (same hash, same nonce),
 * which is exactly what --resume relies on: a tx whose answer got lost is simply sent again, never re-signed.
 */
export async function broadcastAndWait(chain: Chain, raw: Hex, hash: Hex, sleep: Sleep = realSleep, patience = 120): Promise<Receipt> {
  try {
    await chain.sendRaw(raw);
  } catch (err) {
    const msg = String((err as Error).message ?? err);
    const alreadyThere = /already known|known transaction|nonce too low|already imported/i.test(msg);
    if (!alreadyThere && !(await chain.receipt(hash))) throw err;
  }
  for (let i = 0; i < patience; i++) {
    const r = await chain.receipt(hash);
    if (r) return r;
    await sleep(1000);
  }
  throw new Error(`no receipt for ${hash} after ${patience} s; run again with --resume, it will look for it first`);
}

/** Did this receipt really pay `to` exactly `amountRaw`? For USDC that means a Transfer log, for PROS the tx value. */
export function paidRight(r: Receipt, want: { token: Token; from: Address; to: Address; amountRaw: bigint }, tx: TxInfo): boolean {
  if (r.status !== "success") return false;
  if (want.token === "PROS") return tx.to?.toLowerCase() === want.to.toLowerCase() && tx.value === want.amountRaw;
  return r.logs.some(
    (l) =>
      l.address.toLowerCase() === USDC &&
      l.topics[0] === TRANSFER_TOPIC &&
      l.topics[1] === pad(want.from.toLowerCase() as Address) &&
      l.topics[2] === pad(want.to.toLowerCase() as Address) &&
      BigInt(l.data) === want.amountRaw,
  );
}
