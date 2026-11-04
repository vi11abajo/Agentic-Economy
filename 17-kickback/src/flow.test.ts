import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeCommit } from "./commit.js";
import { FakeChain, type FakeOptions } from "./fakechain.js";
import { StopBeforeCommit, resumeDraw, runDraw, type DrawState } from "./flow.js";
import { DEFAULTS, DEFAULT_CAPS } from "./params.js";

// The well-known first anvil key: never holds anything real.
const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ME = account.address.toLowerCase() as Address;
const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const thirty = Array.from({ length: 30 }, (_, i) => who(i + 1));

function setup(o: Partial<FakeOptions> = {}) {
  const chain = new FakeChain({ buyers: thirty, pros: { [ME]: 10n ** 18n }, usdc: { [ME]: 1_000_000n }, ...o });
  mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".test-tmp", "flow-"));
  const lines: string[] = [];
  const deps = { chain, account, caps: DEFAULT_CAPS, home, say: (l: string) => lines.push(l), sleep: async () => {} };
  return { chain, deps, lines };
}

const winnersOf = (s: DrawState) => s.payouts.map((p) => p.winner);

test("dry run signs nothing and lists the pool", async () => {
  const { chain, deps } = setup();
  const state = await runDraw(deps, DEFAULTS, { dry: true });
  assert.equal(state.pool.people.length, 30);
  assert.equal(state.commit, undefined);
  assert.equal(chain.sendCalls.length, 0);
});

test("full draw pays 3 distinct winners from the pool and the commit decodes to the saved pool", async () => {
  const { chain, deps } = setup();
  const state = await runDraw(deps, DEFAULTS, { dry: false });
  const winners = winnersOf(state);
  assert.equal(new Set(winners).size, 3);
  assert.ok(winners.every((w) => thirty.includes(w)));
  assert.ok(state.payouts.every((p) => p.status === "paid"));
  const onChain = await chain.transaction(state.commit!.tx);
  assert.deepEqual(decodeCommit(onChain!.input).pool, state.pool.people);
  assert.equal(state.target!.block, state.commit!.block! + 5n);
  for (const w of winners) assert.equal(chain.usdcTransfersTo(w), 1);
});

test("draw stops before commit when broke", async () => {
  const { chain, deps } = setup({ usdc: { [ME]: 20n } });
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }), (e: unknown) => e instanceof StopBeforeCommit && /USDC/.test((e as Error).message));
  assert.equal(chain.sendCalls.length, 0);
});

test("draw stops before commit without PROS for gas", async () => {
  const { chain, deps } = setup({ pros: { [ME]: 1000n } });
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }), (e: unknown) => e instanceof StopBeforeCommit && /PROS/.test((e as Error).message));
  assert.equal(chain.sendCalls.length, 0);
});

test("draw refuses with fewer than 2 buyers", async () => {
  const { chain, deps } = setup({ buyers: [who(1)] });
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }), StopBeforeCommit);
  assert.equal(chain.sendCalls.length, 0);
});

test("a short pool still draws, and says it was short", async () => {
  const { deps } = setup({ buyers: thirty.slice(0, 5) });
  const state = await runDraw(deps, DEFAULTS, { dry: true });
  assert.equal(state.pool.people.length, 5);
  assert.equal(state.pool.complete, false);
});

test("bad params stop before touching the chain", async () => {
  const { chain, deps } = setup();
  await assert.rejects(runDraw(deps, { ...DEFAULTS, winners: 50 }, { dry: false }), StopBeforeCommit);
  assert.equal(chain.journal.length + chain.sendCalls.length, 0);
});

test("waits through a missing target block", async () => {
  const { chain, deps } = setup();
  for (let b = 10_000n; b < 10_300n; b++) chain.laggyBlocks.add(b);
  const state = await runDraw(deps, DEFAULTS, { dry: false });
  assert.ok(state.target!.hash);
  assert.ok(state.payouts.every((p) => p.status === "paid"));
});

test("a reverting payout is marked failed and the others are paid", async () => {
  const first = setup();
  const winners = winnersOf(await runDraw(first.deps, DEFAULTS, { dry: false }));
  // Same world again, so the same winners come out; this time the second one can't receive USDC.
  const { chain, deps } = setup();
  chain.cursed.add(winners[1]);
  const state = await runDraw(deps, DEFAULTS, { dry: false });
  assert.deepEqual(winnersOf(state), winners);
  assert.deepEqual(state.payouts.map((p) => p.status), ["paid", "failed", "paid"]);
  assert.match(state.payouts[1].error!, /cursed/);
});

test("resume never pays twice", async () => {
  const { chain, deps } = setup();
  chain.killAfterSends = 3; // commit, payout 1, payout 2 go out, then the process "dies"
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }));
  chain.revive();
  const commitTx = chain.sendCalls.length && (await import("viem")).keccak256(chain.sendCalls[0]);
  const state = await resumeDraw(deps, commitTx as `0x${string}`);
  assert.ok(state.payouts.every((p) => p.status === "paid"));
  for (const w of winnersOf(state)) assert.equal(chain.usdcTransfersTo(w), 1);
  const secondRaw = state.payouts[1].raw!;
  assert.equal(chain.sendCalls.filter((r) => r === secondRaw).length, 2, "payout 2 was re-broadcast from the stored raw, not re-signed");
});

test("a node that lags on the nonce doesn't stall the next payout", async () => {
  const { chain, deps } = setup();
  chain.nonceLag = 1; // every nonce answer is one behind, so payout 1 would reuse the commit's nonce
  const state = await runDraw(deps, DEFAULTS, { dry: false });
  assert.ok(state.payouts.every((p) => p.status === "paid"));
  for (const w of winnersOf(state)) assert.equal(chain.usdcTransfersTo(w), 1);
});

test("a second process can't pick up a draw that is still running", async () => {
  const { chain, deps } = setup();
  chain.killAfterSends = 1; // only the commit goes out
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }));
  chain.revive();
  const commitTx = (await import("viem")).keccak256(chain.sendCalls[0]);
  writeFileSync(join(deps.home, "draws", `${commitTx}.lock`), String(process.pid)); // "someone" alive holds it
  await assert.rejects(resumeDraw(deps, commitTx), /already running/);
  assert.equal(chain.sendCalls.length, 1, "nothing was signed or sent by the second process");
  writeFileSync(join(deps.home, "draws", `${commitTx}.lock`), "2147483646"); // a holder that is long gone
  const state = await resumeDraw(deps, commitTx);
  assert.ok(state.payouts.every((p) => p.status === "paid"));
});
