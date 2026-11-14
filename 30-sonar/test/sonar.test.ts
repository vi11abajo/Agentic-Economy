import test from "node:test";
import assert from "node:assert/strict";
import { parseEther } from "viem";
import { classify, explain, moveUsd, netLegs, type Whale } from "../src/explain.js";
import { history, type Leg, type Move } from "../src/history.js";
import { USDC, WPROS, ZERO, type Get } from "../src/pharos.js";
import { build, text } from "../src/report.js";
import { ListError, discover, parseList } from "../src/whales.js";

const W = "0x1111111111111111111111111111111111111111";
const W2 = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";
const FRIEND = "0x4444444444444444444444444444444444444444";
const usdc = USDC.toLowerCase();
const wpros = WPROS.toLowerCase();

const leg = (dir: "in" | "out", symbol: string, token: string | null, amount: number, party: string, contract = false, name?: string): Leg => ({ dir, symbol, token, amount, party: { address: party, contract, name } });
const mv = (legs: Leg[], extra: Partial<Move> = {}): Move => ({ hash: "0xabc", block: 100, time: "2026-11-14T10:00:00.000Z", legs, ...extra });

test("watch list: checked, addresses normalised, duplicates refused", () => {
  const l = parseList(JSON.stringify({ minUsd: 500, whales: [{ address: W.toUpperCase().replace("0X", "0x"), label: "a" }, { address: W2, minUsd: 10 }] }));
  assert.equal(l.whales[0].address, W);
  assert.equal(l.whales[1].label, W2);
  assert.equal(l.whales[1].minUsd, 10);
  assert.throws(() => parseList(`{"whales":[]}`), ListError);
  assert.throws(() => parseList(`{"whales":[{"address":"0x12"}]}`), /not an address/);
  assert.throws(() => parseList(JSON.stringify({ whales: [{ address: W }, { address: W }] })), /twice/);
});

test("net legs: a router handing some back in the same tx is netted out", () => {
  const { outs, ins } = netLegs(mv([leg("out", "USDC", usdc, 100, POOL, true), leg("in", "USDC", usdc, 3, POOL, true), leg("in", "PROS", null, 200, POOL, true)]));
  assert.deepEqual(outs.map((x) => [x.symbol, x.amount]), [["USDC", 97]]);
  assert.deepEqual(ins.map((x) => [x.symbol, x.amount]), [["PROS", 200]]);
});

test("kinds of move", () => {
  const k = (legs: Leg[], called?: Move["called"]) => classify(mv(legs, { called })).kind;
  assert.equal(k([leg("out", "USDC", usdc, 100, POOL, true), leg("in", "WPROS", wpros, 200, POOL, true)]), "swap");
  assert.equal(k([leg("out", "USDC", usdc, 100, POOL, true), leg("in", "vUSDC", "0x55", 99, ZERO)]), "entered");
  assert.equal(k([leg("out", "vUSDC", "0x55", 99, ZERO), leg("in", "USDC", usdc, 101, POOL, true)]), "exited");
  assert.equal(k([leg("out", "PROS", null, 5, FRIEND)]), "sent");
  assert.equal(k([leg("in", "PROS", null, 5, FRIEND)]), "received");
  assert.equal(k([leg("out", "USDC", usdc, 5, POOL, true, "Vault")]), "into-contract");
  assert.equal(k([leg("in", "USDC", usdc, 5, POOL, true)]), "out-of-contract");
  assert.equal(k([leg("in", "USDC", usdc, 5, ZERO)]), "minted");
  assert.match(classify(mv([leg("out", "USDC", usdc, 5, POOL, true, "Vault")])).headline, /put 5 USDC into Vault \(0x3333…3333\)/);
});

test("dollar value: USDC is $1, PROS and WPROS use the feed, others the explorer price or nothing", () => {
  assert.equal(moveUsd(mv([leg("out", "PROS", null, 1000, FRIEND)]), 0.5), 500);
  assert.equal(moveUsd(mv([leg("out", "USDC", usdc, 300, POOL, true), leg("in", "WPROS", wpros, 1000, POOL, true)]), 0.5), 500);
  assert.equal(moveUsd(mv([{ ...leg("in", "FOO", "0x66", 10, FRIEND), explorerPrice: 2 }]), 0.5), 20);
  assert.equal(moveUsd(mv([leg("in", "FOO", "0x66", 10, FRIEND)]), 0.5), undefined);
});

// the explorer API as three lists per address, 100 rows a page
function fakeExplorer(lists: Record<string, Array<Record<string, unknown>>>, extra: Record<string, unknown> = {}): Get & { calls: string[] } {
  const calls: string[] = [];
  const get = (async (path: string) => {
    calls.push(path);
    const [p, q] = path.split("?");
    if (extra[p]) return extra[p];
    const page = Number(new URLSearchParams(q).get("page"));
    return { data: (lists[p] ?? []).slice((page - 1) * 100, page * 100) };
  }) as Get & { calls: string[] };
  get.calls = calls;
  return get;
}

test("history: three lists folded per tx, failed txs, self-sends and NFTs dropped, stops at the window", async () => {
  const t = (h: string, ts: string) => ({ block_number: 100, block_timestamp: ts, transaction_hash: h, hash: h });
  const get = fakeExplorer({
    [`address/${W}/transactions`]: [
      { ...t("0x01", "2026-11-14T10:00:00Z"), from_address: W, to_address: POOL, value: "50", receipt_status: 1, to_addr: { is_contract: true, name: "Router" } },
      { ...t("0x02", "2026-11-14T09:00:00Z"), from_address: W, to_address: FRIEND, value: "7", receipt_status: 0 },
      { ...t("0x03", "2026-11-14T08:00:00Z"), from_address: W, to_address: W, value: "9", receipt_status: 1 },
      { ...t("0x09", "2026-11-10T08:00:00Z"), from_address: W, to_address: FRIEND, value: "9", receipt_status: 1 },
    ],
    [`address/${W}/token_transfers`]: [
      { ...t("0x01", "2026-11-14T10:00:00Z"), log_index: 3, from_address: POOL, to_address: W, value: "20.5", token_address: USDC, token_info: { symbol: "USDC", type: "ERC20" } },
      { ...t("0x04", "2026-11-14T07:00:00Z"), log_index: 0, from_address: FRIEND, to_address: W, value: "1", token_address: "0x77", token_info: { symbol: "NFT", type: "ERC721" } },
    ],
    [`address/${W}/internal_transactions`]: [{ ...t("0x05", "2026-11-14T06:00:00Z"), from_address: POOL, to_address: W, value: "3", status: 1, from_addr: { is_contract: true } }],
  });
  const moves = await history(get, W, "2026-11-13T00:00:00Z");
  assert.deepEqual(moves.map((m) => m.hash).sort(), ["0x01", "0x05"]);
  const swap = moves.find((m) => m.hash === "0x01")!;
  assert.equal(swap.called?.name, "Router");
  assert.equal(classify(swap).kind, "swap");
  assert.match(classify(swap).headline, /swapped 50 PROS for 20.5 USDC via Router/);
});

function fakeChain(opts: { balances?: Record<string, bigint>; feed?: bigint } = {}) {
  return {
    getBalance: async ({ blockNumber }: { blockNumber: bigint }) => opts.balances?.[String(blockNumber)] ?? 0n,
    readContract: async ({ functionName, blockNumber }: { functionName: string; blockNumber?: bigint }) => {
      if (functionName === "latestRoundData") return [1n, opts.feed ?? parseEther("0.5"), 0n, 1_800_000_000n, 1n];
      return opts.balances?.[`usdc:${blockNumber}`] ?? 0n;
    },
    multicall: async ({ contracts }: { contracts: Array<{ address: string }> }) => contracts.map((c) => (c.address === USDC ? 0n : parseEther("1"))),
  } as never;
}

test("why it matters: share of holdings at that block, price against the feed at that block, the other side", async () => {
  const me: Whale = { address: W, label: "big one" };
  const twin: Whale = { address: W2, label: "other big one" };
  const watched = new Map([[W, me], [W2, twin]]);
  // sent 400 of 1000 PROS to another watched whale
  let s = await explain({ client: fakeChain({ balances: { "99": parseEther("1000"), "100": parseEther("600") } }), get: fakeExplorer({}), pros: 0.5, watched }, me, mv([leg("out", "PROS", null, 400, W2)]));
  assert.deepEqual(s.why, ["that was 40% of its PROS: 1,000 before this tx, 600 after", "the other side is another watched whale: other big one"]);
  assert.equal(s.usd, 200);
  // sold 1000 PROS for 450 USDC while the feed said 0.5: 10% under
  s = await explain(
    { client: fakeChain({ balances: { "99": parseEther("5000"), "100": parseEther("4000") }, feed: parseEther("0.5") }), get: fakeExplorer({}), pros: 0.5, watched },
    me,
    mv([leg("out", "PROS", null, 1000, POOL, true, "Pool"), leg("in", "USDC", usdc, 450, POOL, true, "Pool")]),
  );
  assert.ok(s.why.includes("sold PROS at $0.4500; the PROS/USD feed said $0.5000 at that block (-10.0%)"), s.why.join(" | "));
  // paid a fresh wallet that this whale funded itself
  const get = fakeExplorer({}, { [`address/${FRIEND}/profile`]: { first_transaction: { block_timestamp: "2026-11-12T00:00:00+00:00" }, funding_transaction: { from_address: W } } });
  s = await explain({ client: fakeChain(), get, pros: 0.5, watched }, me, mv([leg("out", "PROS", null, 10, FRIEND)]));
  assert.equal(s.why.at(-1), "0x4444…4444 is a wallet: first active 2026-11-12, only 2 days before this, first funded by big one (this whale itself)");
});

test("discover keeps wallets that moved lately, skips contracts and sleepers", async () => {
  const now = new Date("2026-11-14T12:00:00Z");
  const row = (rank: number, contract: boolean, ts: string) => ({ rank, address: `0x${String(rank).padStart(40, "0")}`, balance: "1000000.5", block_timestamp: ts, addr: { is_contract: contract } });
  const get = fakeExplorer({}, { "top-accounts": { data: [row(1, true, "2026-11-14T00:00:00Z"), row(2, false, "2026-10-01T00:00:00Z"), row(3, false, "2026-11-14T01:00:00Z"), row(4, false, "2026-11-13T20:00:00Z")] } });
  const l = await discover(get, 5, 24, now);
  assert.deepEqual(l.whales.map((w) => w.label), ["#3 PROS holder", "#4 PROS holder"]);
});

test("report: per-whale lines and one line for everyone", async () => {
  const t = (h: string) => ({ block_number: 100, block_timestamp: "2026-11-14T10:00:00Z", hash: h, receipt_status: 1 });
  const get = fakeExplorer({
    [`address/${W}/transactions`]: [{ ...t("0x01"), from_address: W, to_address: W2, value: "4000" }],
    [`address/${W2}/transactions`]: [{ ...t("0x01"), from_address: W, to_address: W2, value: "4000" }],
  });
  const list = parseList(JSON.stringify({ minUsd: 1000, whales: [{ address: W, label: "A" }, { address: W2, label: "B" }, { address: FRIEND, label: "C" }] }));
  const r = await build(fakeChain(), get, list, 24, { price: 0.5, updatedAt: 1_800_000_000 }, new Date("2026-11-14T12:00:00Z"));
  const out = text(r);
  assert.match(out, /A {2}0x1111…1111\n {2}holds 1 PROS \+ 0 USDC \+ 1 WPROS ≈ \$1\n {2}1 move, 1 significant · in \$0 · out \$2,000/);
  assert.match(out, /C {2}0x4444…4444\n.*\n {2}nothing moved in the window/);
  assert.match(out, /all watched: hold ≈ \$3 · 2 of 3 moved · 2 moves, 2 significant · in \$2,000 · out \$2,000 · net \+\$0/);
});
