// "Don't trust me, check it." Starts from nothing but the commit tx hash: decode the list and the rule from the
// tx itself, fetch the target block's hash, redo the draw, then look for the payouts on chain.
import { pad, type Address, type Hex } from "viem";
import type { Chain } from "./chain.js";
import { PROS_TOKEN, decodeCommit, type Commit } from "./commit.js";
import { pickWinners, seedOf } from "./lottery.js";
import { USDC } from "./pay.js";

export type Verdict = {
  match: boolean;
  sender: Address;
  commit: Commit;
  commitBlock: bigint;
  target: { block: bigint; hash: Hex };
  seed: Hex;
  winners: Address[];
  payouts: { winner: Address; tx?: Hex; ok: boolean; note: string }[];
  firstDifference?: string;
};

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const PAYOUT_WINDOWS = 2n; // payouts land seconds after the target block; 2000 blocks is plenty of room

export async function verifyDraw(chain: Chain, commitTx: Hex, payoutTxs: Hex[]): Promise<Verdict> {
  chain.step("commit");
  const tx = await chain.transaction(commitTx);
  if (!tx) throw new Error(`no transaction ${commitTx} on Pharos mainnet`);
  if (!tx.to || tx.to.toLowerCase() !== tx.from.toLowerCase()) throw new Error("not a kickback commit (a commit is a transaction to its own sender)");
  const commit = decodeCommit(tx.input);
  const receipt = await chain.receipt(commitTx);
  if (!receipt || receipt.status !== "success") throw new Error("the commit transaction isn't mined successfully");

  chain.step("target");
  const n = receipt.blockNumber + BigInt(commit.delay);
  const block = await chain.block(n);
  if (!block) throw new Error(`block ${n} isn't there yet, so there are no winners yet either`);
  const seed = seedOf(block.hash, commitTx);
  const winners = pickWinners(seed, commit.pool, commit.winners);

  chain.step("payouts");
  const sender = tx.from.toLowerCase() as Address;
  const payouts =
    commit.token === PROS_TOKEN ? await prosPayouts(chain, sender, commit, winners, payoutTxs) : await usdcPayouts(chain, sender, commit, winners, n, payoutTxs);
  const bad = payouts.find((p) => !p.ok);
  return {
    match: !bad,
    sender,
    commit,
    commitBlock: receipt.blockNumber,
    target: { block: n, hash: block.hash },
    seed,
    winners,
    payouts,
    firstDifference: bad ? `winner ${bad.winner}: ${bad.note}` : undefined,
  };
}

async function usdcPayouts(chain: Chain, sender: Address, commit: Commit, winners: Address[], from: bigint, payoutTxs: Hex[]) {
  const found = new Map<Address, Hex>();
  // A draw resumed much later pays outside the windows below, so hashes from the draw report count too.
  for (const h of payoutTxs) {
    const r = await chain.receipt(h);
    if (!r || r.status !== "success" || r.blockNumber < from) continue;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== USDC || l.topics[0] !== TRANSFER_TOPIC || l.topics[1] !== pad(sender)) continue;
      const to = `0x${l.topics[2].slice(26)}` as Address;
      if (winners.includes(to) && BigInt(l.data) === commit.amountRaw && !found.has(to)) found.set(to, h);
    }
  }
  // The node refuses ranges past its head, and right after a draw the chain is only a few blocks past the target.
  const head = await chain.blockNumber();
  for (let w = 0n; w < PAYOUT_WINDOWS && from + w * 1000n <= head; w++) {
    const end = from + w * 1000n + 999n;
    const logs = await chain.logs({
      address: USDC,
      topics: [TRANSFER_TOPIC, pad(sender), winners.map((x) => pad(x))],
      from: from + w * 1000n,
      to: end < head ? end : head,
    });
    for (const l of logs) {
      const to = `0x${l.topics[2].slice(26)}` as Address;
      if (BigInt(l.data) === commit.amountRaw && !found.has(to)) found.set(to, l.transactionHash);
    }
  }
  return winners.map((winner) => {
    const tx = found.get(winner);
    return { winner, tx, ok: Boolean(tx), note: tx ? "paid" : "no payout found" };
  });
}

async function prosPayouts(chain: Chain, sender: Address, commit: Commit, winners: Address[], payoutTxs: Hex[]) {
  // Plain PROS transfers leave no logs, so the payout hashes come from the draw report.
  const seen = new Map<Address, Hex>();
  for (const h of payoutTxs) {
    const t = await chain.transaction(h);
    const r = t && (await chain.receipt(h));
    if (!t || !r || r.status !== "success" || t.from.toLowerCase() !== sender || !t.to) continue;
    if (t.value === commit.amountRaw) seen.set(t.to.toLowerCase() as Address, h);
  }
  return winners.map((winner) => {
    const tx = seen.get(winner);
    return { winner, tx, ok: Boolean(tx), note: tx ? "paid" : "no payout found" };
  });
}
