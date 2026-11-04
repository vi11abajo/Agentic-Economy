import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FakeChain } from "./fakechain.js";
import { resumeDraw, runDraw } from "./flow.js";
import { DEFAULTS, DEFAULT_CAPS, type DrawParams } from "./params.js";
import { verifyDraw } from "./verify.js";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ME = account.address.toLowerCase() as Address;
const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const thirty = Array.from({ length: 30 }, (_, i) => who(i + 1));

async function drawOn(chain: FakeChain, params: DrawParams = DEFAULTS) {
  mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".test-tmp", "verify-"));
  return runDraw({ chain, account, caps: { ...DEFAULT_CAPS, max_total_pros: "1" }, home, say: () => {}, sleep: async () => {} }, params, { dry: false });
}

const world = () => new FakeChain({ buyers: thirty, pros: { [ME]: 10n ** 18n }, usdc: { [ME]: 1_000_000n } });

test("verify matches a real draw", async () => {
  const chain = world();
  const state = await drawOn(chain);
  const v = await verifyDraw(chain, state.commit!.tx, []);
  assert.equal(v.match, true);
  assert.deepEqual(v.winners, state.payouts.map((p) => p.winner));
  assert.deepEqual(v.payouts.map((p) => p.tx), state.payouts.map((p) => p.tx));
  assert.equal(v.target.block, state.target!.block);
});

test("verify reports a difference when a winner got nothing", async () => {
  const first = await drawOn(world());
  const chain = world();
  chain.cursed.add(first.payouts[2].winner);
  const state = await drawOn(chain);
  const v = await verifyDraw(chain, state.commit!.tx, []);
  assert.equal(v.match, false);
  assert.match(v.firstDifference!, new RegExp(first.payouts[2].winner));
  assert.equal(v.payouts[2].note, "no payout found");
});

test("verify checks PROS payouts by the tx hashes it is given", async () => {
  const chain = world();
  const state = await drawOn(chain, { ...DEFAULTS, token: "PROS", amount: "0.0001" });
  const txs = state.payouts.map((p) => p.tx!);
  assert.equal((await verifyDraw(chain, state.commit!.tx, txs)).match, true);
  const missingOne = await verifyDraw(chain, state.commit!.tx, txs.slice(0, 2));
  assert.equal(missingOne.match, false);
});

test("verify rejects a tx that is not a kickback commit", async () => {
  const chain = world();
  const state = await drawOn(chain);
  await assert.rejects(verifyDraw(chain, state.payouts[0].tx!, []), /not a kickback commit/);
});

test("verify accepts USDC payouts that landed late when their hashes are given", async () => {
  const chain = world();
  chain.killAfterSends = 1; // the commit goes out, then the draw stalls for a long while
  mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".test-tmp", "verify-"));
  const deps = { chain, account, caps: DEFAULT_CAPS, home, say: () => {}, sleep: async () => {} };
  await assert.rejects(runDraw(deps, DEFAULTS, { dry: false }));
  chain.revive();
  chain.head += 50_000n; // resumed hours later, far past the log windows verify scans
  const commitTx = (await import("viem")).keccak256(chain.sendCalls[0]);
  const state = await resumeDraw(deps, commitTx);
  const v = await verifyDraw(chain, commitTx, state.payouts.map((p) => p.tx!));
  assert.equal(v.match, true, v.firstDifference);
});
