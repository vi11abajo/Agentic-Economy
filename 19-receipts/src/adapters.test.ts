import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pad, toHex } from "viem";
import { fakeChain } from "./fakechain.js";
import { findHoldings, MORPHO } from "./adapters.js";
import { Ledger } from "./facts.js";
import type { WalletIndex } from "./explorer.js";

process.env.RECEIPTS_HOME = mkdtempSync(join(tmpdir(), "receipts-adapters-"));

const W = "0x00000000000000000000000000000000000000aa";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";
const TOK = "0x0000000000000000000000000000000000000001";
const VS = "0x0000000000000000000000000000000000000002"; // ERC-4626: the token is the vault
const SH = "0x0000000000000000000000000000000000000003"; // ERC-7540 share token
const V = "0x0000000000000000000000000000000000000004"; // ...and its vault
const LP = "0x0000000000000000000000000000000000000005";
const BROKEN = "0x0000000000000000000000000000000000000006";
const X = "0x0000000000000000000000000000000000000007"; // something we can't read
const E18 = 10n ** 18n;
const REQ_TX = "0x" + "11".repeat(32);
const LOST_TX = "0x" + "22".repeat(32);
const MORPHO_TX = "0x" + "33".repeat(32);
const MARKET = "0x" + "ab".repeat(32);

const erc20 = (symbol: string, decimals: number, balance: bigint) => ({ symbol: () => symbol, decimals: () => decimals, balanceOf: () => balance, name: () => symbol });

function transfer(hash: string, token: string, from: string, to: string, value: string, symbol: string, decimals = 18, log = 0) {
  return { transaction_hash: hash, log_index: log, from_address: from, to_address: to, value, token_address: token, block_number: 900, token_info: { symbol, decimals } };
}

const index: WalletIndex = {
  wallet: W,
  fetchedAt: "",
  txs: [
    { hash: REQ_TX, from_address: W, to_address: V, value: "0", method_id: "0x7d41c86e", block_number: 900, receipt_status: 1 },
    { hash: LOST_TX, from_address: W, to_address: X, value: "0", method_id: "0x5696bdae", block_number: 901, receipt_status: 1 },
  ],
  transfers: [
    transfer("0xa1", TOK, "0x99", W, "5", "TOK"),
    transfer("0xa2", VS, "0x0000000000000000000000000000000000000000", W, "10", "vUSD", 6),
    transfer("0xa3", SH, "0x0000000000000000000000000000000000000000", W, "7", "SH"),
    transfer("0xa4", LP, "0x0000000000000000000000000000000000000000", W, "1", "LP"),
    transfer("0xa5", BROKEN, "0x99", W, "1", "BRK"),
    transfer(LOST_TX, USDC, W, X, "3", "USDC", 6),
  ],
  internals: [],
  totals: { txs: 2, transfers: 6, internals: 0 },
};

const contracts = {
  [USDC]: erc20("USDC", 6, 0n),
  [TOK]: erc20("TOK", 18, 5n * E18),
  [VS]: { ...erc20("vUSD", 6, 10_000_000n), asset: () => USDC, convertToAssets: (x: bigint) => (x * 11n) / 10n, name: () => "Steady Vault" },
  [SH]: erc20("SH", 18, 7n * E18),
  [V]: {
    share: () => SH,
    asset: () => USDC,
    name: () => "Async Vault",
    convertToAssets: (x: bigint) => x / 10n ** 12n, // 1 share = 1 USDC
    pendingRedeemRequest: (id: bigint) => (id === 18n ? 3n * E18 : 0n),
    claimableRedeemRequest: () => 0n,
  },
  [LP]: { ...erc20("LP", 18, E18), token0: () => USDC, token1: () => TOK, getReserves: () => [100_000_000n, 400n * E18, 0], totalSupply: () => 4n * E18 },
  [BROKEN]: { symbol: () => "BRK", decimals: () => 18 }, // balanceOf will revert
  [X]: { owner: () => W }, // has code, answers nothing we know
};

const receipts = {
  get_balance: JSON.stringify({ balanceWei: "2000000000000000000" }),
  get_transaction: (a: Record<string, unknown>) => JSON.stringify({ from: W, to: a.hash === MORPHO_TX ? MORPHO : V, value: "0x0" }),
  get_transaction_receipt: (a: Record<string, unknown>) =>
    JSON.stringify({
      blockNumber: "0x384",
      status: "0x1",
      logs: a.hash === MORPHO_TX
        ? [{ address: MORPHO, topics: ["0xedf8870433c83823eb071d3df1caa8d008f12f6440918c20d75a3602cda30fe0", MARKET, pad(W), pad(W)], data: "0x", logIndex: "0x0" }]
        : [{ address: V, topics: ["0x1fdc681a13d8c5da54e301c7ce6542dcde4581e4725043fdab2db12ddc574506", pad(W), pad(W), pad(toHex(18))], data: "0x", logIndex: "0x0" }],
    }),
};

async function scan(extraContracts = {}, ix = index) {
  const line = fakeChain({ ...contracts, ...extraContracts }, receipts);
  const ledger = new Ledger();
  const found = await findHoldings({ line, block: 1000, ledger, wallet: W }, ix);
  return { found, ledger, line };
}

test("plain tokens, native PROS and every read pinned to the scan block", async () => {
  const { found, line } = await scan();
  const tok = found.holdings.find((h) => h.asset === TOK)!;
  assert.equal(tok.kind, "token");
  assert.equal(tok.amount, 5n * E18);
  assert.equal(found.holdings.find((h) => h.symbol === "PROS")!.amount, 2n * E18);
  assert.ok(line.blocks.every((b) => b === "1000"));
});

test("an ERC-4626 share turns into its asset", async () => {
  const { found, ledger } = await scan();
  const v = found.holdings.find((h) => h.asset === VS)!;
  assert.equal(v.kind, "vault");
  assert.equal(v.protocol, "Steady Vault");
  assert.equal(v.underlying![0].amount, 11_000_000n);
  assert.equal(ledger.byId(v.underlying![0].fact)!.value, "11");
});

test("a separate share token is valued through the vault the wallet called", async () => {
  const { found } = await scan();
  const s = found.holdings.find((h) => h.asset === SH && h.kind === "vault")!;
  assert.equal(s.protocol, "Async Vault");
  assert.equal(s.underlying![0].token, USDC);
  assert.equal(s.underlying![0].amount, 7_000_000n);
});

test("an LP token is split into its share of both reserves", async () => {
  const { found } = await scan();
  const lp = found.holdings.find((h) => h.asset === LP)!;
  assert.equal(lp.kind, "lp");
  assert.deepEqual(lp.underlying!.map((u) => u.amount), [25_000_000n, 100n * E18]);
});

test("a pending redeem request is found by the id the vault gave out", async () => {
  const { found } = await scan();
  const f = found.holdings.find((h) => h.kind === "in-flight")!;
  assert.equal(f.amount, 3n * E18);
  assert.match(f.note!, /redeem request 18, waiting/);
  assert.equal(f.underlying![0].amount, 3_000_000n);
});

test("one broken token doesn't sink the scan; it's named with the call that failed", async () => {
  const { found } = await scan();
  const u = found.unknowns.find((x) => x.reason === "read-failed" && x.subject.includes("BRK"))!;
  assert.match(u.subject, /BRK/);
  assert.match(u.details, /balanceOf/);
  assert.ok(found.holdings.some((h) => h.asset === TOK));
  assert.equal(found.checked.tokens, 6);
});

test("money sent into a contract nobody can read is reported, with what went in", async () => {
  const { found, ledger } = await scan();
  const u = found.unknowns.find((x) => x.reason === "no-adapter")!;
  assert.equal(u.subject, X);
  assert.match(u.details, /sent 3 0xc879\.\.\.1815 \[F\d+\] there in 1 tx \(method 0x5696bdae\)/);
  // the amount is a fact, so an answer can quote it and still pass the check
  const id = u.details.match(/\[(F\d+)\]/)![1];
  assert.equal(ledger.byId(id)!.value, "3");
});

test("a Morpho supply position is read from the market the wallet's own receipt names", async () => {
  const ix: WalletIndex = { ...index, txs: [...index.txs, { hash: MORPHO_TX, from_address: W, to_address: MORPHO, value: "0", method_id: "0xa99aad89", block_number: 902, receipt_status: 1 }] };
  const morpho = {
    position: () => [500n, 0n, 0n],
    market: () => [2_000_000n, 1000n, 0n, 0n, 0n, 0n],
    idToMarketParams: () => [USDC, TOK, X, X, 0n],
  };
  const { found } = await scan({ [MORPHO]: morpho }, ix);
  const m = found.holdings.find((h) => h.kind === "lending")!;
  assert.equal(m.amount, 1_000_000n);
  assert.equal(m.protocol, "Morpho TOK/USDC");
});

test("PROS sent to a person is a payment, not an unreadable protocol", async () => {
  const PERSON = "0x00000000000000000000000000000000000000bb";
  const ix: WalletIndex = { ...index, txs: [...index.txs, { hash: "0x" + "44".repeat(32), from_address: W, to_address: PERSON, value: "1.5", method_id: "0x", block_number: 903, receipt_status: 1 }] };
  const { found } = await scan({}, ix);
  assert.ok(!found.unknowns.some((u) => u.subject === PERSON));
  assert.ok(found.unknowns.some((u) => u.subject === X));
});

test("a request whose claimable read reverts is reported, not silently dropped", async () => {
  const halfBroken = { ...contracts[V], pendingRedeemRequest: () => 0n, claimableRedeemRequest: undefined };
  const { found } = await scan({ [V]: halfBroken });
  assert.ok(!found.holdings.some((h) => h.kind === "in-flight"));
  const u = found.unknowns.find((x) => x.subject.startsWith("redeem request 18"))!;
  assert.equal(u.reason, "read-failed");
  assert.match(u.details, /pending reads 0, claimable reverts/);
  assert.match(u.details, /no payment from this vault has arrived since/);
});
