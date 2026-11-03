// send: check again on fresh state with the real signatures, and only then sign and broadcast the one
// transaction. Afterwards, read the chain to say what really happened to each action, and keep any USDC
// signature that wasn't used so `cancel` can void it.
import { decodeFunctionResult, encodeFunctionData, parseSignature, type Hex, type LocalAccount } from "viem";
import { sentData, type Authorization } from "./batch.js";
import { CHAIN_ID, MULTICALL3, USDC, USDC_DOMAIN, multicall3Abi, usdcAuthAbi } from "./book.js";
import type { Chain } from "./chain.js";
import { check, type ActionResult, type Built, type CheckReport } from "./check.js";
import type { Plan } from "./plan.js";

export type SendResult = {
  hash: Hex | null;
  status: "sent_ok" | "reverted" | "refused";
  results: ActionResult[];
  unusedAuthorizations: Authorization[];
  refusals: string[];
  report?: CheckReport;
};
type SendOptions = {
  now: bigint;
  nonceFor: (i: number) => Hex;
  sleep?: (ms: number) => Promise<void>;
  check?: (chain: Chain, plan: Plan, o: { now: bigint; nonceFor: (i: number) => Hex; signer: LocalAccount }) => Promise<CheckReport & { built: Built }>;
};

const RECEIPT_WAIT_MS = 60_000;
const PRIORITY_FEE = 1_000_000_000n; // 1 gwei

async function broadcast(chain: Chain, account: LocalAccount, data: Hex, value: bigint, gas: bigint): Promise<Hex> {
  const price = await chain.gasPrice();
  const raw = await account.signTransaction({ type: "eip1559", chainId: CHAIN_ID, to: MULTICALL3, data, value, gas, nonce: await chain.nonce(account.address), maxFeePerGas: price * 2n, maxPriorityFeePerGas: PRIORITY_FEE });
  return chain.sendRaw(raw);
}

async function waitForReceipt(chain: Chain, hash: Hex, sleep: (ms: number) => Promise<void>) {
  for (let waited = 0; waited <= RECEIPT_WAIT_MS; waited += 2000) {
    const r = await chain.receipt(hash);
    if (r) return r;
    await sleep(2000);
  }
  return null;
}

async function wasUsed(chain: Chain, authorizer: Hex, nonce: Hex): Promise<boolean> {
  const r = await chain.call({ to: USDC, data: encodeFunctionData({ abi: usdcAuthAbi, functionName: "authorizationState", args: [authorizer, nonce] }) });
  if (!r.ok) throw new Error(`couldn't ask USDC whether a payment went through: ${r.message}`);
  return decodeFunctionResult({ abi: usdcAuthAbi, functionName: "authorizationState", data: r.data }) as boolean;
}

export async function send(chain: Chain, plan: Plan, account: LocalAccount, opts: SendOptions): Promise<SendResult> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  if (plan.wallet.toLowerCase() !== account.address.toLowerCase())
    return { hash: null, status: "refused", results: [], unusedAuthorizations: [], refusals: [`the plan pays from ${plan.wallet}, but the key in .env is for ${account.address}`] };

  // Fresh check with the signatures we're about to send: if the price moved or a balance changed, stop here.
  const report = await (opts.check ?? check)(chain, plan, { now: opts.now, nonceFor: opts.nonceFor, signer: account });
  if (!report.sendable) return { hash: null, status: "refused", results: report.results, unusedAuthorizations: [], refusals: report.refusals, report };

  const { built } = report;
  const gas = ((report.batch.gas ?? 0n) * 12n) / 10n;
  const hash = await broadcast(chain, account, sentData(built), built.value, gas);
  const receipt = await waitForReceipt(chain, hash, sleep);
  if (!receipt) throw new Error(`sent ${hash}, but no receipt after ${RECEIPT_WAIT_MS / 1000} s; look it up on pharosscan before doing anything else`);

  if (receipt.status === "reverted")
    return {
      hash,
      status: "reverted",
      results: report.results.map((r) => ({ ...r, ok: false, reason: "the transaction reverted, so nothing happened and the PROS stayed in the wallet" })),
      unusedAuthorizations: built.authorizations,
      refusals: [],
      report,
    };

  // Payments are allowed to fail alone: ask USDC which signatures were really used. Everything that carries PROS
  // can't fail alone, so a mined transaction means those all went through.
  const unused: Authorization[] = [];
  for (const a of built.authorizations) if (!(await wasUsed(chain, account.address, a.nonce))) unused.push(a);
  const results = report.results.map((r) => (unused.some((u) => u.action === r.action) ? { ...r, ok: false, reason: "this payment failed inside the batch; its signature is unused until it expires" } : r));
  return { hash, status: "sent_ok", results, unusedAuthorizations: unused, refusals: [], report };
}

/** Voids signed-but-unused USDC payments, so nobody can submit them later. One transaction, signed by the wallet. */
export async function cancel(chain: Chain, account: LocalAccount, auths: Authorization[], opts: { sleep?: (ms: number) => Promise<void> } = {}): Promise<Hex> {
  const calls = [];
  for (const a of auths) {
    const signature = await account.signTypedData({
      domain: USDC_DOMAIN,
      types: { CancelAuthorization: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }] },
      primaryType: "CancelAuthorization",
      message: { authorizer: account.address, nonce: a.nonce },
    });
    const { r, s, v, yParity } = parseSignature(signature);
    calls.push({ target: USDC, allowFailure: true, value: 0n, callData: encodeFunctionData({ abi: usdcAuthAbi, functionName: "cancelAuthorization", args: [account.address, a.nonce, Number(v ?? BigInt(yParity + 27)), r, s] }) });
  }
  const data = encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [calls] });
  const gas = (await chain.estimateGas?.({ from: account.address, to: MULTICALL3, data }).catch(() => null)) ?? 60_000n * BigInt(auths.length + 1);
  const hash = await broadcast(chain, account, data, 0n, (gas * 12n) / 10n);
  await waitForReceipt(chain, hash, opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))));
  return hash;
}
