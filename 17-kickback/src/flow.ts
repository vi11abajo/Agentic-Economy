// The whole draw, start to finish, from one call. The order matters and is the point of the design:
// the list and the rule go on chain first, and only then do we look at the block that picks the winners.
import { formatUnits, parseTransaction, type Address, type Hex, type LocalAccount } from "viem";
import { RevertedCall, type CallLog, type Chain } from "./chain.js";
import { collectPool, findPairs, type Pool } from "./buyers.js";
import { PROS_TOKEN, encodeCommit } from "./commit.js";
import { pickWinners, seedOf } from "./lottery.js";
import { DECIMALS, amountRaw, checkParams, type Caps, type DrawParams } from "./params.js";
import { USDC, broadcastAndWait, paidRight, realSleep, signTx, usdcTransfer, type Sleep } from "./pay.js";
import { appendHistory, holdDraw, loadDraw, saveDraw } from "./store.js";

export type Payout = { winner: Address; raw?: Hex; tx?: Hex; status: "pending" | "sent" | "paid" | "failed"; error?: string };
export type DrawState = {
  version: 1;
  params: DrawParams;
  wallet: Address;
  pool: Pool;
  commit?: { raw: Hex; tx: Hex; block?: bigint };
  target?: { block: bigint; hash?: Hex };
  seed?: Hex;
  payouts: Payout[];
  calls: CallLog[];
  startedAt: string;
  finishedAt?: string;
};
export type Deps = { chain: Chain; account: LocalAccount; caps: Caps; home: string; say: (line: string) => void; sleep?: Sleep };

/** Something is off before anything was signed: nothing went on chain, nothing to clean up. */
export class StopBeforeCommit extends Error {}

const BALANCE_OF = "0x70a08231";

export async function runDraw(deps: Deps, params: DrawParams, opts: { dry: boolean }): Promise<DrawState> {
  const { chain, account, caps, say } = deps;
  const me = account.address.toLowerCase() as Address;
  const problems = checkParams(params, caps);
  if (problems.length) throw new StopBeforeCommit(problems.join("; "));
  const each = amountRaw(params);
  const decimals = DECIMALS[params.token];

  chain.step("snapshot");
  const snapshot = await chain.blockNumber();
  say(`snapshot: block ${snapshot}, everything below is "as of" this block`);

  chain.step("pairs");
  const pairs = await findPairs(chain, snapshot);
  say(`pairs: ${pairs.length} Prosper V2 pools (WPROS against a p-token)`);

  chain.step("pool");
  const pool = await collectPool(chain, pairs, { snapshot, size: params.pool, lookback: caps.lookback_blocks, exclude: [me] });
  const shortNote = pool.complete ? "" : ` (only ${pool.people.length} in the last ${caps.lookback_blocks} blocks, drawing from those)`;
  say(`pool: ${pool.people.length} people who bought, blocks ${pool.scannedFrom}..${snapshot}, skipped ${pool.skippedContracts} contracts${shortNote}`);
  if (pool.people.length < 2) throw new StopBeforeCommit(`found ${pool.people.length} buyers in the last ${caps.lookback_blocks} blocks; a draw needs at least 2`);
  if (params.winners >= pool.people.length) throw new StopBeforeCommit(`only ${pool.people.length} buyers found, can't pick ${params.winners} winners from them`);

  const commitData = encodeCommit({
    snapshot,
    delay: params.delay,
    winners: params.winners,
    token: params.token === "USDC" ? USDC : PROS_TOKEN,
    amountRaw: each,
    pool: pool.people,
  });

  chain.step("budget");
  const pros = await chain.balance(me);
  const usdc = params.token === "USDC" ? BigInt(await chain.call(USDC, `${BALANCE_OF}${me.slice(2).padStart(64, "0")}` as Hex)) : 0n;
  const payTotal = each * BigInt(params.winners);
  if (params.token === "USDC" && usdc < payTotal) {
    throw new StopBeforeCommit(`not enough USDC: the wallet has ${formatUnits(usdc, 6)}, the cashback needs ${formatUnits(payTotal, 6)}`);
  }
  const gasPrice = await chain.gasPrice();
  const commitGas = await chain.estimateGas({ from: me, to: me, data: commitData });
  const payGas = await payoutGas(chain, me, pool.people[0], params.token, each);
  const worstGas = (gasPrice * (commitGas + payGas * BigInt(params.winners)) * 12n) / 10n;
  const prosNeeded = worstGas + (params.token === "PROS" ? payTotal : 0n);
  if (pros < prosNeeded) throw new StopBeforeCommit(`not enough PROS: the wallet has ${formatUnits(pros, 18)}, gas${params.token === "PROS" ? " plus the cashback" : ""} needs up to ${formatUnits(prosNeeded, 18)}`);
  say(`budget: paying ${params.winners} x ${params.amount} ${params.token} = ${formatUnits(payTotal, decimals)}, gas at most ${formatUnits(worstGas, 18)} PROS; wallet has ${formatUnits(pros, 18)} PROS${params.token === "USDC" ? ` and ${formatUnits(usdc, 6)} USDC` : ""}`);

  const state: DrawState = { version: 1, params, wallet: me, pool, payouts: [], calls: chain.journal, startedAt: new Date().toISOString() };
  if (opts.dry) {
    say("dry run: nothing signed, nothing sent");
    return state;
  }

  chain.step("commit");
  const signed = await signTx(chain, account, { to: me, data: commitData });
  state.commit = { raw: signed.raw, tx: signed.hash };
  const release = holdDraw(deps.home, signed.hash);
  try {
    saveDraw(deps.home, signed.hash, state); // saved before it leaves, so a crash right here can still be resumed
    const receipt = await broadcastAndWait(chain, signed.raw, signed.hash, deps.sleep ?? realSleep);
    state.commit.block = receipt.blockNumber;
    saveDraw(deps.home, signed.hash, state);
    say(`commit: tx ${signed.hash} in block ${receipt.blockNumber}; the list and the rule are on chain now`);
    return await carryOn(deps, state);
  } finally {
    release();
  }
}

export async function resumeDraw(deps: Deps, commitTx: Hex): Promise<DrawState> {
  const state = loadDraw<DrawState>(deps.home, commitTx);
  if (!state?.commit) throw new Error(`no saved draw for ${commitTx} in ${deps.home}/draws`);
  const release = holdDraw(deps.home, commitTx);
  try {
    deps.say(`resume: picking up draw ${commitTx}`);
    state.calls = deps.chain.journal;
    return await carryOn(deps, state);
  } finally {
    release();
  }
}

// Everything after the commit. Each step looks at what's already done, so a resumed draw skips it.
async function carryOn(deps: Deps, state: DrawState): Promise<DrawState> {
  const { chain, say } = deps;
  const sleep = deps.sleep ?? realSleep;
  const commit = state.commit!;
  const save = () => saveDraw(deps.home, commit.tx, state);

  if (commit.block === undefined) {
    chain.step("commit");
    commit.block = (await broadcastAndWait(chain, commit.raw, commit.tx, sleep)).blockNumber;
    save();
  }

  if (!state.target?.hash) {
    chain.step("target");
    const n = commit.block + BigInt(state.params.delay);
    state.target = { block: n };
    say(`target: waiting for block ${n} (commit block + ${state.params.delay}); its hash doesn't exist yet`);
    state.target.hash = await waitForBlockHash(chain, n, sleep);
    save();
    say(`target: block ${n} hash ${state.target.hash}`);
  }

  if (!state.seed) {
    state.seed = seedOf(state.target.hash!, commit.tx);
    const winners = pickWinners(state.seed, state.pool.people, state.params.winners);
    state.payouts = winners.map((winner) => ({ winner, status: "pending" }));
    save();
    say(`draw: seed ${state.seed}; winners ${winners.join(", ")}`);
  }

  chain.step("payout");
  const each = amountRaw(state.params);
  for (const p of state.payouts) {
    if (p.status === "paid" || p.status === "failed") continue;
    if (p.status === "pending") {
      const tx = state.params.token === "USDC" ? { to: USDC, data: usdcTransfer(p.winner, each) } : { to: p.winner, value: each };
      const signed = await signWithOneRetry(chain, deps.account, tx, sleep, nextFreeNonce(state));
      if ("error" in signed) {
        p.status = "failed";
        p.error = signed.error;
        save();
        say(`payout: ${p.winner} FAILED before sending: ${signed.error}`);
        continue;
      }
      Object.assign(p, { raw: signed.raw, tx: signed.hash, status: "sent" });
      save(); // the raw tx is on disk before it goes out: resume re-sends these exact bytes, never a second payment
    }
    const receipt = await broadcastAndWait(chain, p.raw!, p.tx!, sleep);
    const info = await chain.transaction(p.tx!);
    const ok = info !== null && paidRight(receipt, { token: state.params.token, from: state.wallet, to: p.winner, amountRaw: each }, info);
    p.status = ok ? "paid" : "failed";
    if (!ok) p.error = receipt.status === "reverted" ? "reverted on chain" : "the receipt doesn't show the transfer";
    save();
    say(`payout: ${p.winner} ${ok ? "paid" : `FAILED (${p.error})`} in tx ${p.tx}`);
  }

  state.finishedAt = new Date().toISOString();
  save();
  appendHistory(deps.home, state);
  const paid = state.payouts.filter((p) => p.status === "paid").length;
  say(`done: ${paid} of ${state.payouts.length} paid. Anyone can re-check it: kickback verify ${commit.tx}`);
  return state;
}

async function waitForBlockHash(chain: Chain, n: bigint, sleep: Sleep): Promise<Hex> {
  // Blocks come about once a second; give it the delay plus five minutes of slack before calling it stuck.
  for (let i = 0; i < 360; i++) {
    if ((await chain.blockNumber()) >= n) {
      const b = await chain.block(n); // can still be null on a node that is a block behind
      if (b) return b.hash;
    }
    await sleep(1000);
  }
  throw new Error(`block ${n} didn't show up in time; run again with --resume`);
}

async function payoutGas(chain: Chain, me: Address, someone: Address, token: DrawParams["token"], each: bigint): Promise<bigint> {
  const tx = (to: Address) => (token === "USDC" ? { from: me, to: USDC, data: usdcTransfer(to, each) } : { from: me, to, value: each });
  try {
    return await chain.estimateGas(tx(someone));
  } catch (err) {
    if (!(err instanceof RevertedCall)) throw err;
    // One odd recipient shouldn't block the whole budget check; a transfer to ourselves costs about the same.
    return chain.estimateGas(tx(me));
  }
}

// Every tx this draw signed used a nonce; the next one has to be above all of them, whatever a lagging node says.
function nextFreeNonce(state: DrawState): number {
  const used = [state.commit?.raw, ...state.payouts.map((p) => p.raw)].filter((r): r is Hex => Boolean(r));
  return Math.max(-1, ...used.map((r) => parseTransaction(r).nonce ?? 0)) + 1;
}

async function signWithOneRetry(chain: Chain, account: LocalAccount, tx: { to: Address; data?: Hex; value?: bigint }, sleep: Sleep, minNonce: number) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await signTx(chain, account, tx, minNonce);
    } catch (err) {
      if (!(err instanceof RevertedCall)) throw err;
      if (attempt >= 2) return { error: err.message };
      await sleep(2000);
    }
  }
}
