import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { main, parseArgs } from "./cli.js";
import { FakeChain } from "./fakechain.js";
import { DEFAULTS } from "./params.js";

const account = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const ME = account.address.toLowerCase() as Address;
const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const HASH = `0x${"ab".repeat(32)}`;

test("parseArgs: draw with no flags is the defaults", () => {
  assert.deepEqual(parseArgs(["draw"]), { cmd: "draw", params: DEFAULTS, dry: false, payoutTxs: [] });
});

test("parseArgs: every draw flag lands where it should", () => {
  const got = parseArgs(["draw", "--winners", "5", "--pool", "50", "--token", "pros", "--amount", "0.0001", "--delay", "8", "--dry"]);
  assert.deepEqual(got, { cmd: "draw", params: { pool: 50, winners: 5, amount: "0.0001", token: "PROS", delay: 8 }, dry: true, payoutTxs: [] });
});

test("parseArgs: an unknown flag is an error, not a silent default", () => {
  assert.ok("error" in parseArgs(["draw", "--winnerz", "5"]));
});

test("parseArgs: verify takes the commit and optional payout hashes", () => {
  assert.deepEqual(parseArgs(["verify", HASH, HASH]), { cmd: "verify", params: DEFAULTS, dry: false, commitTx: HASH, payoutTxs: [HASH] });
  assert.ok("error" in parseArgs(["verify", "0x1234"]));
});

test("parseArgs: --resume needs a 32-byte hash", () => {
  assert.ok("error" in parseArgs(["draw", "--resume", "0xabc"]));
  assert.equal((parseArgs(["draw", "--resume", HASH]) as { resume?: string }).resume, HASH);
});

function run(argv: string[], chain: FakeChain) {
  mkdirSync(join(process.cwd(), ".test-tmp"), { recursive: true });
  const home = mkdtempSync(join(process.cwd(), ".test-tmp", "cli-"));
  const out: string[] = [];
  const code = main(argv, { print: (s) => void out.push(s), home, chain, account, sleep: async () => {} });
  return code.then((c) => ({ code: c, text: out.join("\n") }));
}

test("draw --dry prints the pool and exits 0", async () => {
  const chain = new FakeChain({ buyers: Array.from({ length: 30 }, (_, i) => who(i + 1)), pros: { [ME]: 10n ** 18n }, usdc: { [ME]: 1_000_000n } });
  const r = await run(["draw", "--dry"], chain);
  assert.equal(r.code, 0);
  assert.match(r.text, /pool: 30 people/);
  assert.match(r.text, /dry run/);
});

test("a stop before the commit exits 2 and says why", async () => {
  const chain = new FakeChain({ buyers: [who(1)], pros: { [ME]: 10n ** 18n }, usdc: { [ME]: 1_000_000n } });
  const r = await run(["draw"], chain);
  assert.equal(r.code, 2);
  assert.match(r.text, /needs at least 2/);
  assert.equal(chain.sendCalls.length, 0);
});

test("draw then verify: exit 0 and MATCH", async () => {
  const chain = new FakeChain({ buyers: Array.from({ length: 30 }, (_, i) => who(i + 1)), pros: { [ME]: 10n ** 18n }, usdc: { [ME]: 1_000_000n } });
  const drawn = await run(["draw"], chain);
  assert.equal(drawn.code, 0);
  const commitTx = /kickback verify (0x[0-9a-f]{64})/.exec(drawn.text)![1];
  const v = await run(["verify", commitTx], chain);
  assert.equal(v.code, 0);
  assert.match(v.text, /MATCH/);
});
