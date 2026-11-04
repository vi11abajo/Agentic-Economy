// send: the only path to the signer, and it starts with a fresh gate() at this very moment. Anything but ALLOW
// returns before the key is touched. On ALLOW it signs the exact tx that was traced (same to, data, value, the
// gas limit from that estimate), writes the hash to the log BEFORE broadcasting (so a crash can't hide a send),
// then waits for the receipt and logs what really left the wallet.
import { keccak256, type Address, type Hex, type LocalAccount } from "viem";
import { appendEntry } from "./audit.js";
import { CHAIN_ID, type Chain } from "./chain.js";
import { gate, type Verdict } from "./gate.js";
import { loadPolicy, type Policy } from "./policy.js";
import type { Request } from "./request.js";
import { readTrace, type Facts } from "./trace.js";

export type SendOutcome = { verdict: Verdict; hash: Hex | null; status: "denied" | "sent" | "reverted" | "unknown"; note?: string; spent?: Record<string, string> };

const PRIORITY_FEE = 1_000_000_000n; // 1 gwei, as in 15-onego
const RECEIPT_WAIT_MS = 120_000;
const POLL_MS = 2000;
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What leaves the wallet, keyed like the policy's spend section, as raw-unit strings for the log. */
function amountsByKey(policy: Policy, prosOut: bigint, tokensOut: Facts["tokensOut"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (prosOut > 0n) out.PROS = prosOut.toString();
  for (const [token, amount] of tokensOut) {
    const key = Object.keys(policy.spend).find((k) => policy.spend[k].token === token) ?? token;
    out[key] = (BigInt(out[key] ?? "0") + amount).toString();
  }
  return out;
}

export async function sendGated(chain: Chain, home: string, request: Request, account: LocalAccount, opts: { now: Date; sleep?: (ms: number) => Promise<void> }): Promise<SendOutcome> {
  const sleep = opts.sleep ?? nap;
  const verdict = await gate(chain, home, request, { now: opts.now, signer: account.address.toLowerCase() as Address });
  if (verdict.decision !== "allow" || !verdict.tx || !verdict.gasLimit || !verdict.maxFee || !verdict.facts) return { verdict, hash: null, status: "denied" };

  const loaded = loadPolicy(home);
  if ("problems" in loaded) return { verdict, hash: null, status: "denied", note: "the policy changed under us between the check and the signature" };
  const { tx, facts } = verdict;
  const raw = await account.signTransaction({ type: "eip1559", chainId: CHAIN_ID, to: tx.to, data: tx.data, value: tx.value, gas: verdict.gasLimit, maxFeePerGas: verdict.maxFee, maxPriorityFeePerGas: PRIORITY_FEE, nonce: await chain.nonce(tx.from) });
  const hash = keccak256(raw);
  await appendEntry(home, { kind: "sent", txHash: hash, amounts: amountsByKey(loaded.policy, facts.prosOut, facts.tokensOut) }, new Date());

  try {
    await chain.sendRaw(raw);
  } catch (err) {
    return { verdict, hash, status: "unknown", note: `broadcasting failed (${(err as Error).message}); it may still have reached the node, so look ${hash} up on pharosscan before sending again` };
  }

  for (let waited = 0; waited <= RECEIPT_WAIT_MS; waited += POLL_MS) {
    const receipt = await chain.receipt(hash).catch(() => null); // a blip while polling isn't an answer
    if (receipt) {
      // PROS sent leaves no event, so it's the traced amount; tokens are counted from this tx's own Transfer logs.
      const fromReceipt = readTrace({ type: "LOGS", from: "0x0000000000000000000000000000000000000000", logs: receipt.logs }, tx.from);
      const spent = receipt.status === "success" ? amountsByKey(loaded.policy, facts.prosOut, fromReceipt.tokensOut) : {};
      await appendEntry(home, { kind: "receipt", txHash: hash, status: receipt.status, block: receipt.blockNumber.toString(), gasUsed: receipt.gasUsed.toString(), amounts: spent }, new Date());
      return { verdict, hash, status: receipt.status === "success" ? "sent" : "reverted", spent };
    }
    await sleep(POLL_MS);
  }
  return { verdict, hash, status: "unknown", note: `sent ${hash}, but no receipt after ${RECEIPT_WAIT_MS / 1000} s; it still counts against today's cap until a receipt says otherwise` };
}
