// One payment = one signed transaction, built here and handed back as raw bytes. The caller writes it to the
// journal BEFORE broadcasting, so whatever happens next (crash, timeout, node hiccup) the same bytes can be sent
// again and can never turn into a second, different payment.
//
// USDC goes through transferWithAuthorization (EIP-3009) even though the bookkeeper pays from its own wallet: the
// authorization nonce is derived from (series, period, payee), and USDC itself refuses a nonce it has seen. So the
// token contract, not our journal, is what makes "this period is paid at most once" true. The window
// [due - 1 s, next due) also means the chain refuses an early payment and a payment for a period that is over.
import { encodeAbiParameters, encodeFunctionData, keccak256, type PrivateKeyAccount } from "viem";
import { CHAIN_ID, USDC, USDC_ABI, type Chain } from "./chain.js";
import type { Hex } from "./store.js";

export const USDC_DOMAIN = { name: "USDC", version: "2", chainId: CHAIN_ID, verifyingContract: USDC } as const;
export const AUTH_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** The same series, period and payee always give the same nonce; anything else gives another one. */
export function paymentNonce(wallet: Hex, seriesId: string, period: number, payee: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "string" }, { type: "address" }, { type: "string" }, { type: "uint256" }, { type: "uint256" }],
      ["bookkeeper/v1", wallet, seriesId, BigInt(period), BigInt(payee)],
    ),
  );
}

export interface BuiltPayment {
  raw: Hex;
  hash: Hex;
  to: Hex; // the contract or person the tx is sent to
  data?: Hex;
  value?: bigint;
  gas: bigint;
  gasPrice: bigint;
  txNonce: number;
}

// eth_estimateGas can come back a little short on calls that go through a proxy; a fifth on top costs a few cents.
const withHeadroom = (g: bigint) => (g * 6n) / 5n;

async function signTx(account: PrivateKeyAccount, chain: Chain, tx: { to: Hex; data?: Hex; value?: bigint }, gas: bigint): Promise<BuiltPayment> {
  const [gasPrice, txNonce] = await Promise.all([chain.gasPrice(), chain.pendingNonce(account.address)]);
  const raw = (await account.signTransaction({ type: "legacy", chainId: CHAIN_ID, to: tx.to, data: tx.data, value: tx.value ?? 0n, gas, gasPrice, nonce: txNonce })) as Hex;
  return { raw, hash: keccak256(raw), to: tx.to, data: tx.data, value: tx.value, gas, gasPrice, txNonce };
}

export async function usdcCall(account: PrivateKeyAccount, to: Hex, value: bigint, validAfter: bigint, validBefore: bigint, nonce: Hex): Promise<Hex> {
  const sig = await account.signTypedData({ domain: USDC_DOMAIN, types: AUTH_TYPES, primaryType: "TransferWithAuthorization", message: { from: account.address, to, value, validAfter, validBefore, nonce } });
  const r = sig.slice(0, 66) as Hex;
  const s = ("0x" + sig.slice(66, 130)) as Hex;
  const v = parseInt(sig.slice(130, 132), 16);
  return encodeFunctionData({ abi: USDC_ABI, functionName: "transferWithAuthorization", args: [account.address, to, value, validAfter, validBefore, nonce, v, r, s] });
}

export async function buildUsdcPayment(account: PrivateKeyAccount, chain: Chain, p: { to: Hex; value: bigint; validAfter: bigint; validBefore: bigint; nonce: Hex }): Promise<BuiltPayment> {
  const data = await usdcCall(account, p.to, p.value, p.validAfter, p.validBefore, p.nonce);
  const gas = withHeadroom(await chain.estimateGas({ from: account.address, to: USDC, data }));
  return signTx(account, chain, { to: USDC, data }, gas);
}

export async function buildProsPayment(account: PrivateKeyAccount, chain: Chain, p: { to: Hex; value: bigint }): Promise<BuiltPayment> {
  const gas = withHeadroom(await chain.estimateGas({ from: account.address, to: p.to, value: p.value }));
  return signTx(account, chain, { to: p.to, value: p.value }, gas);
}
