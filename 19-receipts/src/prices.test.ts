import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeChain } from "./fakechain.js";
import { Pricer, PROS_USD_FEED, PROSPER_V2_FACTORY, USDC } from "./prices.js";
import { WPROS } from "./chain.js";
import { NATIVE, type Holding } from "./adapters.js";
import { Ledger } from "./facts.js";
import type { WalletIndex } from "./explorer.js";

const E18 = 10n ** 18n;
const W = "0x00000000000000000000000000000000000000aa";
const PTACO = "0x52acdeb49056518578c7af788ae2c367132e2db5";
const PAIR = "0xaf2b77d76c6256826c2b650aa6d0bbf297a0e7b8";
const PMUSK = "0xe318ac4113324841265d270dc2393f1bf742a7f8";
const MARKET = "0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f";
const NOBODY = "0x0000000000000000000000000000000000000009";
const VAULT = "0x0000000000000000000000000000000000000008";

const emptyIndex = (transfers: WalletIndex["transfers"] = []): WalletIndex => ({ wallet: W, fetchedAt: "", txs: [], transfers, internals: [], totals: { txs: 0, transfers: transfers.length, internals: 0 } });

const chain = {
  [PROS_USD_FEED]: { decimals: () => 18, latestRoundData: () => [1n, 519n * 10n ** 15n, 0n, 1_762_366_510n, 1n] }, // 0.519
  [PROSPER_V2_FACTORY]: { allPairsLength: () => 1n, allPairs: () => PAIR },
  // pTACO is token0: 23,000,000 pTACO against 200,000 WPROS -> 0.0087 WPROS each
  [PAIR]: { token0: () => PTACO, token1: () => WPROS, getReserves: () => [23_000_000n * E18, 200_000n * E18, 0] },
  [PTACO]: { symbol: () => "pTACO", decimals: () => 18 },
  [PMUSK]: { symbol: () => "pMusk", decimals: () => 18 },
  [MARKET]: { pToken: () => PMUSK, quoteSell: (x: bigint) => [x / 100_000n, 0n, x / 100_000n] }, // 0.00001 WPROS each
  [NOBODY]: { symbol: () => "NOPE", decimals: () => 18 },
};

const buyFromMarket = { transaction_hash: "0x01", log_index: 0, from_address: MARKET, to_address: W, value: "10", token_address: PMUSK, block_number: 5, token_info: { symbol: "pMusk", decimals: 18 } };

function pricer(ix = emptyIndex()) {
  const line = fakeChain(chain as never);
  const ledger = new Ledger();
  return { p: new Pricer(line, ledger, ix), ledger, line };
}

test("USDC is 1, PROS comes from the Chainlink feed and the fact says so", async () => {
  const { p, ledger } = pricer();
  assert.equal(((await p.price(USDC, 1000)) as { usd: number }).usd, 1);
  const pros = await p.price(NATIVE, 1000);
  assert.ok("usd" in pros);
  assert.equal(pros.usd, 0.519);
  const f = ledger.byId(pros.facts[0])!;
  assert.equal(f.contract, PROS_USD_FEED);
  assert.match(f.call!, /latestRoundData/);
});

test("a graduated Prosper token is priced from its V2 pair and PROS", async () => {
  const { p } = pricer();
  const r = await p.price(PTACO, 1000);
  assert.ok("usd" in r);
  assert.ok(Math.abs(r.usd - (200_000 / 23_000_000) * 0.519) < 1e-12);
  assert.match(r.how, /pair/);
});

test("a token on the curve is priced by quoteSell on the market it was bought from", async () => {
  const { p } = pricer(emptyIndex([buyFromMarket]));
  const r = await p.price(PMUSK, 1000, 1000n * E18);
  assert.ok("usd" in r);
  assert.ok(Math.abs(r.usd - 0.00001 * 0.519) < 1e-15);
  assert.match(r.how, /quoteSell/);
});

test("no route at all is an Unknown that lists what was tried", async () => {
  const { p } = pricer();
  const r = await p.price(NOBODY, 1000);
  assert.ok("reason" in r);
  assert.equal(r.reason, "no-price-route");
  assert.match(r.details, /Prosper V2 pairs.*curve market/);
});

test("a past block is passed through to every read", async () => {
  const { p, line } = pricer();
  await p.price(PTACO, 777);
  assert.ok(line.blocks.length > 0);
  assert.ok(line.blocks.every((b) => b === "777"));
});

test("holdings are valued through their underlying; debt counts against the total; unpriced ones are left out", async () => {
  const { p } = pricer();
  const holdings: Holding[] = [
    { kind: "vault", protocol: "V", asset: VAULT, symbol: "vUSD", amount: 5n, decimals: 6, underlying: [{ token: USDC, amount: 2_000_000n, fact: "F1" }], facts: ["F1"] },
    { kind: "token", protocol: "wallet", asset: NATIVE, symbol: "PROS", amount: 10n * E18, decimals: 18, facts: ["F2"] },
    { kind: "debt", protocol: "Morpho", asset: USDC, symbol: "USDC", amount: 1_000_000n, decimals: 6, facts: ["F3"] },
    { kind: "token", protocol: "wallet", asset: NOBODY, symbol: "NOPE", amount: E18, decimals: 18, facts: ["F4"] },
  ];
  const v = await p.value(holdings, 1000);
  assert.equal(v.lines[0].usd, 2);
  assert.ok(Math.abs(v.lines[1].usd! - 5.19) < 1e-9);
  assert.equal(v.lines[2].usd, -1);
  assert.equal(v.lines[3].usd, undefined);
  assert.ok(Math.abs(v.total - 6.19) < 1e-9);
  assert.deepEqual(v.excluded, ["NOPE"]);
});
