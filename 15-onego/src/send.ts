// send: check again on fresh state with the real signatures, and only then sign and broadcast the one
// transaction. The hash is written down before it goes out, so a network hiccup can't make anyone send twice
// blind. After mining, what's reported is what the chain says, not the forecast: tokens from the receipt's own
// Transfer events, PROS from the balances.
import { decodeFunctionResult, encodeFunctionData, keccak256, parseSignature, type Address, type Hex, type LocalAccount } from "viem";
import { encodeBatch, sentData, type Authorization } from "./batch.js";
import { CHAIN_ID, MULTICALL3, USDC, USDC_DOMAIN, multicall3Abi, usdcAuthAbi } from "./book.js";
import type { Chain, Receipt } from "./chain.js";
import { check, type ActionResult, type Built, type CheckReport } from "./check.js";
import type { Plan } from "./plan.js";
import { multicallKeeps } from "./verdict.js";

export type SendResult = {
  hash: Hex | null;
  status: "sent_ok" | "reverted" | "refused";
  results: ActionResult[];
  unusedAuthorizations: Authorization[];
  leftovers: Array<{ symbol: string; amount: bigint }>;
  refusals: string[];
  report?: CheckReport;
};
/** What's known the moment the transaction is signed, before it leaves: enough to find it and cancel leftovers. */
export type Signed = { hash: Hex; authorizations: Authorization[] };
type SendOptions = {
  now: bigint;
  nonceFor: (i: number) => Hex;
  sleep?: (ms: number) => Promise<void>;
  onSigned?: (s: Signed) => Promise<void>;
  check?: (chain: Chain, plan: Plan, o: { now: bigint; nonceFor: (i: number) => Hex; signer: LocalAccount }) => Promise<CheckReport & { built: Built }>;
};

const RECEIPT_WAIT_MS = 60_000;
const PRIORITY_FEE = 1_000_000_000n; // 1 gwei
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const TRANSFER: Hex = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/** How much of `token` this transaction moved into `holder`, minus what it moved out, read from its Transfer events. */
function flowIn(logs: Receipt["logs"], token: Address, holder: Address): bigint {
  const h = holder.toLowerCase();
  const who = (topic: Hex | undefined) => (topic ? `0x${topic.slice(-40)}`.toLowerCase() : "");
  let net = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== token.toLowerCase() || l.topics[0] !== TRANSFER || l.topics.length < 3) continue;
    const amount = BigInt(l.data);
    if (who(l.topics[2]) === h) net += amount;
    if (who(l.topics[1]) === h) net -= amount;
  }
  return net;
}

async function signFor(chain: Chain, account: LocalAccount, data: Hex, value: bigint, gas: bigint): Promise<Hex> {
  const price = await chain.gasPrice();
  return account.signTransaction({ type: "eip1559", chainId: CHAIN_ID, to: MULTICALL3, data, value, gas, nonce: await chain.nonce(account.address), maxFeePerGas: price * 2n, maxPriorityFeePerGas: PRIORITY_FEE });
}

async function waitForReceipt(chain: Chain, hash: Hex, sleep: (ms: number) => Promise<void>) {
  for (let waited = 0; waited <= RECEIPT_WAIT_MS; waited += 2000) {
    const r = await chain.receipt(hash).catch(() => null); // a blip while polling isn't a verdict
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
  const sleep = opts.sleep ?? nap;
  if (plan.wallet.toLowerCase() !== account.address.toLowerCase())
    return { hash: null, status: "refused", results: [], unusedAuthorizations: [], leftovers: [], refusals: [`the plan pays from ${plan.wallet}, but the key in .env is for ${account.address}`] };

  // Fresh check with the signatures we're about to send: if the price moved or a balance changed, stop here.
  const report = await (opts.check ?? check)(chain, plan, { now: opts.now, nonceFor: opts.nonceFor, signer: account });
  const { built } = report;
  // The check showed these signatures to the node already; if we stop, they must stay cancellable.
  if (!report.sendable) return { hash: null, status: "refused", results: report.results, unusedAuthorizations: built.authorizations, leftovers: [], refusals: report.refusals, report };

  const raw = await signFor(chain, account, sentData(built), built.value, ((report.batch.gas ?? 0n) * 12n) / 10n);
  const hash = keccak256(raw);
  await opts.onSigned?.({ hash, authorizations: built.authorizations });
  try {
    await chain.sendRaw(raw);
  } catch (err) {
    throw new Error(`broadcasting ${hash} failed (${(err as Error).message}); it may still have reached the node. Look it up on pharosscan before sending again`);
  }
  const receipt = await waitForReceipt(chain, hash, sleep);
  if (!receipt) throw new Error(`sent ${hash}, but no receipt after ${RECEIPT_WAIT_MS / 1000} s; look it up on pharosscan before doing anything else`);

  if (receipt.status === "reverted")
    return {
      hash,
      status: "reverted",
      results: report.results.map((r) => ({ ...r, ok: false, got: undefined, reason: "the transaction reverted, so no PROS or token moved; USDC signatures in it are now public, cancel them" })),
      unusedAuthorizations: built.authorizations,
      leftovers: [],
      refusals: [],
      report,
    };

  // Payments are allowed to fail alone: ask USDC which signatures were really used.
  const unused: Authorization[] = [];
  for (const a of built.authorizations) if (!(await wasUsed(chain, account.address, a.nonce))) unused.push(a);

  // Then the same balances the check watched. A token's balance read now would also count whatever else
  // reached that wallet since the check (a live airdrop once showed 238.82 USDC "received" for a 0.00001
  // payment), so tokens are counted from this transaction's Transfer events. PROS leaves no events, so PROS is
  // read from the chain.
  const after = new Map<string, bigint>();
  const read = await chain.call({ from: account.address, to: MULTICALL3, value: 0n, data: encodeBatch(built.readBacks) });
  const rows = read.ok ? (decodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3Value", data: read.data }) as Array<{ success: boolean; returnData: Hex }>) : [];
  built.readBacks.forEach((rb, k) => {
    const key = `${rb.reads!.holder}|${rb.reads!.asset}`.toLowerCase();
    if (rb.reads!.asset !== "PROS") after.set(key, (built.before.get(key) ?? 0n) + flowIn(receipt.logs, rb.reads!.asset, rb.reads!.holder));
    else if (rows[k]?.success) after.set(key, BigInt(rows[k].returnData));
  });
  const measured = (holder: string, symbol: string) => {
    const rb = built.readBacks.find((x) => x.reads!.holder.toLowerCase() === holder.toLowerCase() && x.reads!.symbol === symbol);
    if (!rb || (rb.reads!.asset === "PROS" && !read.ok)) return undefined;
    const key = `${rb.reads!.holder}|${rb.reads!.asset}`.toLowerCase();
    return (after.get(key) ?? 0n) - (built.before.get(key) ?? 0n);
  };

  const results = report.results.map((r): ActionResult => {
    if (unused.some((u) => u.action === r.action)) return { ...r, ok: false, got: undefined, reason: "this payment failed inside the batch; its signature is unused until it expires" };
    const a = plan.actions[r.action];
    const holder = a.kind === "buy" ? plan.wallet : a.to;
    const amount = r.got ? measured(holder, r.got.symbol) : undefined;
    return amount === undefined || !r.got ? r : { ...r, got: { ...r.got, amount } };
  });
  const leftovers = multicallKeeps(built.readBacks, built.before, after);
  return { hash, status: "sent_ok", results, unusedAuthorizations: unused, leftovers, refusals: [], report };
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
  const raw = await signFor(chain, account, data, 0n, (gas * 12n) / 10n);
  const hash = keccak256(raw);
  await chain.sendRaw(raw);
  const receipt = await waitForReceipt(chain, hash, opts.sleep ?? nap);
  if (!receipt) throw new Error(`sent the cancel ${hash}, but no receipt yet; check pharosscan`);
  if (receipt.status === "reverted") throw new Error(`the cancel ${hash} reverted: the signatures are NOT voided`);
  // A used or cancelled authorization reads as "used"; anything still open means the cancel didn't take.
  const open = [];
  for (const a of auths) if (!(await wasUsed(chain, account.address, a.nonce))) open.push(a.nonce);
  if (open.length) throw new Error(`the cancel ${hash} went through, but ${open.length} signature(s) are still open: ${open.join(", ")}`);
  return hash;
}
