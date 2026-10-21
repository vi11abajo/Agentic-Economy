// Decision logic on real snapshots of two Prosper markets (test/fixtures, recorded from Pharos mainnet with
// `snapshot()`): pMusk, and Penguin where one outside wallet holds 9.16% of the supply.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { getAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { MarketSnapshot } from "./chain.js";
import { evaluateBuy, evaluateSell, realHolders, topHolder, type Position } from "./checks.js";
import { decisionChecks, parseAssignments, parseValue, type Config } from "./config.js";
import { costBasis } from "./entry.js";
import { protocolWallets } from "./prosper.js";
import { parseEnv, signer } from "./wallet.js";

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../test/fixtures/${name}`, import.meta.url), "utf8")) as MarketSnapshot;
const MUSK = fixture("snapshot-pmusk.json");
const PENG = fixture("snapshot-ppeng.json");

const FACTORY = "0xefdbb0ea7647b0e21aef7a3b7a5d6a632c3116c8";
const ESCROW = "0xc8f6d453d3c3cea8a046f6d4ab683b0c4db9a4d5";
const PROSPER7 = "0x158432eed50e944b4148d46b5e7df5d083706811";

const cfg = (s: string): Config => parseAssignments(s.split(" "), null);
const BUY = cfg("max_fdv_usd=10k min_holders=3 holder_min_pros=1 max_holder_share_pct=5 min_time_left_hours=48 max_progress_pct=50 advise_max_price_impact_pct=3");
const SELL = cfg("take_profit_pct=50 stop_loss_pct=25 max_reserve_drop_pct=30 max_holder_drop=2 max_whale_share_pct=5 advise_max_slippage_pct=5 holder_min_pros=1");
const small = (s: MarketSnapshot) => ({ pros: 1, net: 0.99, tokensOut: 0.99 / s.spot });

describe("who counts as a holder", () => {
  it("finds Prosper's own wallets in the creation transaction (mint, market, escrow, 7% contract)", () => {
    const w = protocolWallets([
      { from: "0x0000000000000000000000000000000000000000", to: FACTORY },
      { from: FACTORY, to: MUSK.market.toLowerCase() },
      { from: FACTORY, to: ESCROW },
      { from: FACTORY, to: PROSPER7 },
    ]);
    assert.deepEqual([...w].sort(), [FACTORY, MUSK.market.toLowerCase(), ESCROW, PROSPER7].sort());
    assert.deepEqual([...MUSK.protocol!].sort(), [...w].sort(), "the recorded snapshot read the same split from chain");
  });

  it("leaves out Prosper wallets, you, and dust", () => {
    const all = realHolders(MUSK, 0, null)!;
    assert.ok(all.every((h) => !MUSK.protocol!.includes(h.address)));
    const me = all[0].address;
    assert.equal(realHolders(MUSK, 0, me)!.length, all.length - 1);
    assert.ok(realHolders(MUSK, 1, null)!.length < all.length || all.every((h) => h.balance * MUSK.spot >= 1));
  });

  it("flags a stranger's 9% bag on Penguin, but not Prosper's 20% escrow or 7% contract", () => {
    const top = topHolder(PENG, null)!;
    assert.equal(top.address, "0xe7368221de15a7c5e0a50a95317b06e6d08c3861");
    assert.ok(top.pct > 9 && top.pct < 9.3, `got ${top.pct}`);
    assert.ok(topHolder(MUSK, null)!.pct < 1);
  });
});

describe("buy: all checks must pass", () => {
  it("APE on pMusk with these thresholds", () => {
    const d = evaluateBuy(MUSK, BUY, small(MUSK), null);
    assert.equal(d.verdict, "APE", d.reason);
    assert.equal(d.checks.filter((c) => !c.advisory).length, 5);
    assert.equal(d.needsApproval, false);
  });

  it("NOPE on Penguin, and says why", () => {
    const d = evaluateBuy(PENG, BUY, small(PENG), null);
    assert.equal(d.verdict, "NOPE");
    assert.match(d.reason, /top holder 9\.\d\d%/);
  });

  it("follows the thresholds, nothing is hard-coded: a lower FDV cap flips pMusk to NOPE", () => {
    const strict = parseAssignments(["max_fdv_usd=1000"], BUY);
    const d = evaluateBuy(MUSK, strict, small(MUSK), null);
    assert.equal(d.verdict, "NOPE");
    assert.match(d.reason, /^FDV \$[\d,]+, limit <= \$1,000/);
  });

  it("price impact is advice: it never blocks, it asks", () => {
    const touchy = parseAssignments(["advise_max_price_impact_pct=0"], BUY);
    const d = evaluateBuy(MUSK, touchy, { pros: 4, net: 3.96, tokensOut: (3.96 / MUSK.spot) * 0.97 }, null);
    assert.equal(d.verdict, "APE");
    assert.equal(d.needsApproval, true);
  });

  it("fails closed: no holder list or a stale PROS/USD feed means NOPE, not a blind buy", () => {
    const noHolders = evaluateBuy({ ...MUSK, holders: null, holdersError: "explorer unavailable (no healthy upstream)" }, BUY, small(MUSK), null);
    assert.equal(noHolders.verdict, "NOPE");
    assert.match(noHolders.reason, /couldn't check holders: n\/a \(explorer unavailable/);
    const stale = evaluateBuy({ ...MUSK, prosUsdAge: 3 * 3600 }, BUY, small(MUSK), null);
    assert.equal(stale.verdict, "NOPE");
    assert.match(stale.reason, /couldn't check FDV/);
  });

  it("only checks what's switched on", () => {
    const fewer = parseAssignments(["max_progress_pct=off", "min_time_left_hours=off"], BUY);
    assert.deepEqual(decisionChecks("buy", fewer), ["max_fdv_usd", "min_holders", "max_holder_share_pct"]);
    assert.equal(evaluateBuy(MUSK, fewer, small(MUSK), null).checks.filter((c) => !c.advisory).length, 3);
  });
});

describe("sell: any rule says exit", () => {
  const holders = realHolders(MUSK, 1, null)!.length;
  const entry = (p: Partial<Position> = {}): Position => ({
    wallet: "0x0000000000000000000000000000000000000001", token: MUSK.token, market: MUSK.market, symbol: "pMusk",
    cost: 10, tokens: 1_000_000, reserve: MUSK.reserve, holders, block: MUSK.block, timestamp: MUSK.timestamp, source: "entered by user", ...p,
  });
  const bag = (value: number) => ({ tokens: 1_000_000, value });

  it("HOLD when nothing moved", () => {
    const d = evaluateSell(MUSK, SELL, entry(), bag(9.9), null);
    assert.equal(d.verdict, "HOLD", d.reason);
  });

  it("EXIT on stop loss and on take profit", () => {
    assert.match(evaluateSell(MUSK, SELL, entry(), bag(7), null).reason, /^stop loss: -30\.0%/);
    assert.match(evaluateSell(MUSK, SELL, entry(), bag(16), null).reason, /^take profit: \+60\.0%/);
  });

  it("EXIT when the curve lost PROS since entry", () => {
    const d = evaluateSell(MUSK, SELL, entry({ reserve: MUSK.reserve * 2 }), bag(9.9), null);
    assert.equal(d.verdict, "EXIT");
    assert.match(d.reason, /^liquidity drain: -50\.0%/);
  });

  it("EXIT when holders left", () => {
    const d = evaluateSell(MUSK, SELL, entry({ holders: holders + 3 }), bag(9.9), null);
    assert.match(d.reason, /^holder exodus/);
  });

  it("EXIT when a whale shows up (Penguin's 9% wallet)", () => {
    const d = evaluateSell(PENG, SELL, entry({ token: PENG.token, reserve: PENG.reserve, holders: realHolders(PENG, 1, null)!.length }), bag(9.9), null);
    assert.match(d.reason, /^whale: 9\.\d\d%/);
  });

  it("a rule it can't read stays quiet instead of selling", () => {
    const d = evaluateSell({ ...MUSK, holders: null }, SELL, entry({ cost: 0 }), bag(9.9), null);
    assert.equal(d.verdict, "HOLD");
    assert.match(d.reason, /couldn't read: P&L, holder exodus, whale/);
  });

  it("slippage is advice: EXIT still stands, but the agent must ask", () => {
    const d = evaluateSell(MUSK, SELL, entry(), { tokens: 1_000_000, value: 1_000_000 * MUSK.spot * 0.7 }, null);
    assert.equal(d.verdict, "EXIT");
    assert.equal(d.needsApproval, true);
  });
});

describe("entry cost of a bag bought by hand", () => {
  it("averages buys, and a sell takes its share of the cost", () => {
    const b = costBasis([
      { side: "buy", block: 1, logIndex: 0, pros: 10, tokens: 1000 },
      { side: "buy", block: 2, logIndex: 0, pros: 30, tokens: 1000 },
      { side: "sell", block: 3, logIndex: 0, pros: 25, tokens: 1000 },
    ]);
    assert.deepEqual(b, { cost: 20, tokens: 1000 });
  });
});

describe("config the way people type it", () => {
  it("reads 10k, $10,000, 5%, 48h, 2d, 1.5 PROS and off", () => {
    assert.equal(parseValue("10k", "usd"), 10_000);
    assert.equal(parseValue("$10,000", "usd"), 10_000);
    assert.equal(parseValue("5%", "pct"), 5);
    assert.equal(parseValue("48h", "hours"), 48);
    assert.equal(parseValue("2d", "hours"), 48);
    assert.equal(parseValue("1.5 PROS", "pros"), 1.5);
    assert.equal(parseValue("off", "pct"), null);
    assert.throws(() => parseValue("2d", "pct"), /days only/);
  });

  it("takes a public address for wallet and refuses anything that looks like a key", () => {
    assert.equal(cfg("wallet=0x2b578bdcf252b2d379c6b9c3caea10b5563a2a8c").wallet, getAddress("0x2b578bdcf252b2d379c6b9c3caea10b5563a2a8c"));
    assert.throws(() => cfg(`wallet=${generatePrivateKey()}`), /public 0x address/);
    assert.throws(() => cfg("max_fdv=10k"), /Unknown setting "max_fdv"/);
  });
});

describe("the key comes from .env only", () => {
  it("reads PRIVATE_KEY from a .env file and derives the address", () => {
    const pk = generatePrivateKey();
    const env = parseEnv(`# trenchscope\nPRIVATE_KEY="${pk}"\n`);
    assert.equal(signer(env)!.address, privateKeyToAccount(pk).address);
    assert.equal(signer({}), null, "no key: advice only");
  });
});
