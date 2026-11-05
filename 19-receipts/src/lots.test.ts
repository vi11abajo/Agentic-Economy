import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pad, toHex } from "viem";
import { fakeChain } from "./fakechain.js";
import { tokenStory, vaultEarnings } from "./lots.js";
import { Pricer, PROS_USD_FEED, PROSPER_V2_FACTORY, USDC } from "./prices.js";
import { WPROS } from "./chain.js";
import { Ledger } from "./facts.js";
import type { WalletIndex } from "./explorer.js";

const W = "0x00000000000000000000000000000000000000aa";
const DEX = "0x00000000000000000000000000000000000000dd";
const FRIEND = "0x00000000000000000000000000000000000000ff";
const TOK = "0x0000000000000000000000000000000000000001";
const PAIR = "0x0000000000000000000000000000000000000002";
const E18 = 10n ** 18n;
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

type Leg = { token: string; from: string; to: string; amount: bigint };
type FakeTx = { hash: string; block: number; from: string; value?: bigint; legs: Leg[]; explorerOverride?: Record<number, string> };

let seq = 0;
function world(txs: FakeTx[], balance: bigint, opts: { reserves?: [bigint, bigint] } = {}) {
  process.env.RECEIPTS_HOME = mkdtempSync(join(tmpdir(), `receipts-lots-${seq++}-`));
  const byHash = new Map(txs.map((t) => [t.hash, t]));
  const index: WalletIndex = {
    wallet: W,
    fetchedAt: "",
    txs: txs.filter((t) => t.from === W).map((t) => ({ hash: t.hash, from_address: W, to_address: DEX, value: String(Number(t.value ?? 0n) / 1e18), method_id: "0x12345678", block_number: t.block, receipt_status: 1 })),
    transfers: txs.flatMap((t) => t.legs.map((l, i) => ({
      transaction_hash: t.hash, log_index: i, from_address: l.from, to_address: l.to, token_address: l.token, block_number: t.block,
      value: t.explorerOverride?.[i] ?? String(Number(l.amount) / (l.token === USDC ? 1e6 : 1e18)),
      token_info: { symbol: l.token === USDC ? "USDC" : "TOK", decimals: l.token === USDC ? 6 : 18 },
    })).filter((r) => r.from_address === W || r.to_address === W)),
    internals: [],
    totals: { txs: 0, transfers: 0, internals: 0 },
  };
  const [rTok, rW] = opts.reserves ?? [1000n * E18, 400n * E18]; // TOK = 0.4 PROS = 0.2 USD at PROS 0.5
  const line = fakeChain({
    [PROS_USD_FEED]: { decimals: () => 18, latestRoundData: () => [1n, 5n * 10n ** 17n, 0n, 1_762_366_510n, 1n] },
    [PROSPER_V2_FACTORY]: { allPairsLength: () => 1n, allPairs: () => PAIR },
    [PAIR]: { token0: () => TOK, token1: () => WPROS, getReserves: () => [rTok, rW, 0] },
    [TOK]: { symbol: () => "TOK", decimals: () => 18, balanceOf: () => balance },
  } as never, {
    get_transaction: (a) => {
      const t = byHash.get(String(a.hash))!;
      return JSON.stringify({ from: t.from, to: DEX, value: toHex(t.value ?? 0n) });
    },
    get_transaction_receipt: (a) => {
      const t = byHash.get(String(a.hash))!;
      return JSON.stringify({ blockNumber: toHex(t.block), status: "0x1", logs: t.legs.map((l, i) => ({ address: l.token, topics: [TRANSFER, pad(l.from as `0x${string}`), pad(l.to as `0x${string}`)], data: toHex(l.amount, { size: 32 }), logIndex: toHex(i) })) });
    },
  });
  const ledger = new Ledger();
  const pricer = new Pricer(line, ledger, index);
  return { ctx: { line, ledger, pricer, ix: index, block: 1000, wallet: W }, ledger };
}

const buy = (hash: string, block: number, tok: bigint, usdc: bigint): FakeTx => ({ hash, block, from: W, legs: [{ token: USDC, from: W, to: DEX, amount: usdc }, { token: TOK, from: DEX, to: W, amount: tok }] });
const sell = (hash: string, block: number, tok: bigint, usdc: bigint): FakeTx => ({ hash, block, from: W, legs: [{ token: TOK, from: W, to: DEX, amount: tok }, { token: USDC, from: DEX, to: W, amount: usdc }] });
const gift = (hash: string, block: number, tok: bigint): FakeTx => ({ hash, block, from: FRIEND, legs: [{ token: TOK, from: FRIEND, to: W, amount: tok }] });
const h = (n: number) => "0x" + n.toString(16).padStart(64, "0");

test("buy 100 for 10, sell 50 for 8: average cost 0.1, realized +3, the rest marked to market", async () => {
  const { ctx, ledger } = world([buy(h(1), 10, 100n * E18, 10_000_000n), sell(h(2), 20, 50n * E18, 8_000_000n)], 50n * E18);
  const s = await tokenStory(ctx, TOK);
  assert.equal(s.unknowns.length, 0, JSON.stringify(s.unknowns));
  assert.ok(Math.abs(s.avgCostUsd! - 0.1) < 1e-12);
  assert.ok(Math.abs(s.realizedUsd! - 3) < 1e-9);
  assert.ok(Math.abs(s.unrealizedUsd! - (50 * 0.2 - 5)) < 1e-9);
  assert.equal(ledger.byId(s.facts.realized!)!.value, "3");
});

test("a token that only ever arrived as a gift: no profit claimed, only the price move since it came", async () => {
  const { ctx } = world([gift(h(3), 10, 5n * E18)], 5n * E18);
  const s = await tokenStory(ctx, TOK);
  assert.equal(s.realizedUsd, undefined);
  assert.equal(s.unrealizedUsd, undefined);
  const u = s.unknowns.find((x: { reason: string }) => x.reason === "received-not-bought")!;
  assert.match(u.details, /received 5 TOK/);
  assert.match(ctx.ledger.facts().find((f) => f.label.startsWith("received"))!.label, /in a tx sent by another wallet, 0x0000...00ff; this wallet paid nothing/);
  assert.equal(s.received.length, 1);
  assert.ok(s.received[0].priceThenUsd !== undefined);
});

test("sold more than was bought: P&L only on the bought part, the rest is called received", async () => {
  const { ctx } = world([gift(h(4), 5, 100n * E18), buy(h(5), 10, 50n * E18, 5_000_000n), sell(h(6), 20, 120n * E18, 12_000_000n)], 30n * E18);
  const s = await tokenStory(ctx, TOK);
  assert.ok(Math.abs(s.realizedUsd! - 0) < 1e-9); // 50 bought for 5, sold for 12 x 50/120 = 5
  assert.ok(Math.abs(s.soldReceivedUsd! - 7) < 1e-9);
  assert.equal(s.unrealizedUsd, undefined, "what's left was received, not bought");
});

test("a balance with no incoming history has no cost basis, and says so", async () => {
  const { ctx } = world([], 7n * E18);
  const s = await tokenStory(ctx, TOK);
  const u = s.unknowns.find((x: { reason: string }) => x.reason === "no-cost-basis")!;
  assert.match(u.details, /no incoming transfers/);
});

test("history that doesn't add up to the chain balance gives no number, just the two figures", async () => {
  const { ctx } = world([buy(h(7), 10, 100n * E18, 10_000_000n)], 60n * E18);
  const s = await tokenStory(ctx, TOK);
  assert.equal(s.realizedUsd, undefined);
  const u = s.unknowns.find((x: { reason: string }) => x.reason === "history-incomplete")!;
  assert.match(u.details, /history adds up to 100 TOK but the chain holds 60/);
});

test("when the explorer and the receipt disagree, the receipt wins and the mismatch is reported", async () => {
  const t = buy(h(8), 10, 100n * E18, 10_000_000n);
  t.explorerOverride = { 1: "99" };
  const { ctx } = world([t], 100n * E18);
  const s = await tokenStory(ctx, TOK);
  const u = s.unknowns.find((x: { reason: string }) => x.reason === "explorer-chain-mismatch")!;
  assert.match(u.details, /explorer says 99 TOK.*receipt says 100/);
  assert.ok(Math.abs(s.avgCostUsd! - 0.1) < 1e-12, "the cost uses the receipt's 100, not the explorer's 99");
});

test("one trade that can't be priced means no profit figure at all, and the reason says which", async () => {
  const ODD = "0x00000000000000000000000000000000000000ee";
  const t1 = buy(h(9), 10, 100n * E18, 10_000_000n);
  const t2: FakeTx = { hash: h(10), block: 20, from: W, legs: [{ token: TOK, from: W, to: DEX, amount: 50n * E18 }, { token: ODD, from: DEX, to: W, amount: E18 }] };
  const { ctx } = world([t1, t2], 50n * E18);
  const s = await tokenStory(ctx, TOK);
  assert.equal(s.realizedUsd, undefined);
  assert.equal(s.unrealizedUsd, undefined);
  assert.ok(s.unknowns.some((u: { reason: string; details: string }) => u.reason === "no-price-route" && /got back 0x0000...00ee/.test(u.details)));
});

test("a vault position: earned = worth now + taken out - put in, in the vault's own asset", async () => {
  const VLT = "0x00000000000000000000000000000000000000c1";
  const dep: FakeTx = { hash: h(11), block: 10, from: W, legs: [{ token: USDC, from: W, to: VLT, amount: 10_000_000n }, { token: VLT, from: "0x0000000000000000000000000000000000000000", to: W, amount: 10n * E18 }] };
  const out: FakeTx = { hash: h(12), block: 20, from: W, legs: [{ token: VLT, from: W, to: "0x0000000000000000000000000000000000000000", amount: 2n * E18 }, { token: USDC, from: VLT, to: W, amount: 2_100_000n }] };
  const { ctx, ledger } = world([dep, out], 8n * E18);
  const holding = { kind: "vault" as const, protocol: "Steady", asset: VLT, symbol: "sV", amount: 8n * E18, decimals: 18, underlying: [{ token: USDC, amount: 8_900_000n, fact: "F0" }], facts: [] };
  const e = await vaultEarnings(ctx, holding);
  assert.ok("earned" in e, "reason" in e ? e.details : "");
  assert.equal(e.deposited, 10_000_000n);
  assert.equal(e.withdrawn, 2_100_000n);
  assert.equal(e.earned, 1_000_000n);
  assert.equal(ledger.byId(e.fact)!.value, "1");
});

test("a vault of some other token reports earnings in that token's symbol, not its address", async () => {
  const VLT = "0x00000000000000000000000000000000000000c1";
  const dep: FakeTx = { hash: h(13), block: 10, from: W, legs: [{ token: TOK, from: W, to: VLT, amount: 3n * E18 }, { token: VLT, from: "0x0000000000000000000000000000000000000000", to: W, amount: 3n * E18 }] };
  const { ctx, ledger } = world([dep], 0n);
  const holding = { kind: "vault" as const, protocol: "Staked TOK", asset: VLT, symbol: "sTOK", amount: 3n * E18, decimals: 18, underlying: [{ token: TOK, amount: 3n * E18 + E18 / 10n, fact: "F0" }], facts: [] };
  const e = await vaultEarnings(ctx, holding);
  assert.ok("earned" in e, "reason" in e ? e.details : "");
  assert.equal(ledger.byId(e.fact)!.unit, "TOK");
  assert.equal(ledger.byId(e.facts[1])!.unit, "TOK");
});

test("vault shares the history can't account for give no earnings figure", async () => {
  const VLT = "0x00000000000000000000000000000000000000c1";
  const dep: FakeTx = { hash: h(21), block: 10, from: W, legs: [{ token: USDC, from: W, to: VLT, amount: 10_000_000n }, { token: VLT, from: "0x0000000000000000000000000000000000000000", to: W, amount: 10n * E18 }] };
  const { ctx } = world([dep], 12n * E18);
  const holding = { kind: "vault" as const, protocol: "Steady", asset: VLT, symbol: "sV", amount: 12n * E18, decimals: 18, underlying: [{ token: USDC, amount: 12_600_000n, fact: "F0" }], facts: [] };
  const e = await vaultEarnings(ctx, holding);
  assert.ok("reason" in e && e.reason === "history-incomplete", JSON.stringify(e, (_, v) => (typeof v === "bigint" ? String(v) : v)));
});

test("vault shares that came from another wallet give no earnings figure", async () => {
  const VLT = "0x00000000000000000000000000000000000000c1";
  const dep: FakeTx = { hash: h(31), block: 10, from: W, legs: [{ token: USDC, from: W, to: VLT, amount: 10_000_000n }, { token: VLT, from: "0x0000000000000000000000000000000000000000", to: W, amount: 10n * E18 }] };
  const gift: FakeTx = { hash: h(32), block: 11, from: FRIEND, legs: [{ token: VLT, from: FRIEND, to: W, amount: 5n * E18 }] };
  const { ctx } = world([dep, gift], 15n * E18);
  const holding = { kind: "vault" as const, protocol: "Steady", asset: VLT, symbol: "sV", amount: 15n * E18, decimals: 18, underlying: [{ token: USDC, amount: 15_750_000n, fact: "F0" }], facts: [] };
  const e = await vaultEarnings(ctx, holding);
  assert.ok("reason" in e && e.reason === "received-not-bought");
});

test("history after the scan's pinned block is left out", async () => {
  const VLT = "0x00000000000000000000000000000000000000c1";
  const dep: FakeTx = { hash: h(41), block: 10, from: W, legs: [{ token: USDC, from: W, to: VLT, amount: 10_000_000n }, { token: VLT, from: "0x0000000000000000000000000000000000000000", to: W, amount: 10n * E18 }] };
  const later: FakeTx = { hash: h(42), block: 2000, from: W, legs: [{ token: VLT, from: W, to: "0x0000000000000000000000000000000000000000", amount: 2n * E18 }, { token: USDC, from: VLT, to: W, amount: 2_100_000n }] };
  const { ctx } = world([dep, later], 10n * E18); // ctx.block is 1000
  const holding = { kind: "vault" as const, protocol: "Steady", asset: VLT, symbol: "sV", amount: 10n * E18, decimals: 18, underlying: [{ token: USDC, amount: 10_500_000n, fact: "F0" }], facts: [] };
  const e = await vaultEarnings(ctx, holding);
  assert.ok("earned" in e, "reason" in e ? e.details : "");
  assert.equal(e.withdrawn, 0n);
  assert.equal(e.earned, 500_000n);
});
