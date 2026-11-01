// Tests without a network: the routing decision, failure isolation, revert decoding, state overrides, the
// transactions each adapter builds, plan checking, loan math and the RPC retry.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, decodeFunctionData, encodeErrorResult, getAddress, keccak256, pad, parseAbi, toFunctionSelector, toHex, type Address, type Hex, type PublicClient } from "viem";
import { annualize, depositSteps, VAULT, withdrawSteps, type Ctx, type Quote } from "./adapters.js";
import { ERRORS, explainRevert, mergeOverrides, morphoCollateralOverride, rpcRequest, tokenOverride, USDC, type Step } from "./chain.js";
import { journalRequestIds, PROBE, quoteAll } from "./cli.js";
import { checkPlan, requestsIn } from "./exec.js";
import { health } from "./morpho.js";
import { DEFAULT_CONDITIONS, route, type Conditions } from "./router.js";
import { DEFAULTS } from "./settings.js";
import { findVenue, VENUES, type Venue } from "./venues.js";

const venue = (id: string) => findVenue(id) as Venue;
const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb" as Address;

function q(id: string, o: Partial<Quote> = {}): Quote {
  return { venue: venue(id), status: "open", decimals: 6, apy: { d7: 5, d30: 5 }, exitDays: 0, exitHow: "at once", exitFeePct: 0, asyncDeposit: false, notes: [], tvl: 1e6, ...o };
}
const cond = (o: Partial<Conditions> = {}): Conditions => ({ amount: 50, ...DEFAULT_CONDITIONS, ...o });

describe("router", () => {
  it("ranks on the lower of the 7-day and 30-day yield and explains the pick against the next one", () => {
    const r = route([q("prnh", { apy: { d7: 37.3, d30: 13.5 }, exitDays: 1 }), q("roxusdc", { apy: { d7: 5, d30: 4.3 } }), q("sharpbyte", { apy: { d7: 7.6, d30: 4.8 } })], cond());
    assert.deepEqual(r.ranked.map((x) => x.quote.venue.id), ["prnh", "sharpbyte", "roxusdc"]);
    assert.equal(r.ranked[0].apy, 13.5);
    assert.match(r.explanation.join(" "), /13\.50% a year, the lower of its realized yields \(7d 37\.30%, 30d 13\.50%\)/);
    assert.match(r.explanation.join(" "), /8\.70 points above the next one, SharpByte/);
  });

  it("spreads a one-off exit fee over the horizon", () => {
    const apt = q("axilpot", { apy: { d7: 9, d30: 9 }, exitFeePct: 0.15 });
    assert.equal(route([apt], cond({ horizonDays: 90 })).ranked[0].net.toFixed(4), (9 - (0.15 * 365) / 90).toFixed(4));
    // over a short stay the fee costs more than a fee-free venue earns less
    const r = route([apt, q("sharpbyte", { apy: { d7: 7, d30: 7 } })], cond({ horizonDays: 10 }));
    assert.equal(r.ranked[0].quote.venue.id, "sharpbyte");
  });

  it("gives every venue it leaves out a reason, one per condition", () => {
    const r = route(
      [
        q("vrpcs", { status: "closed", reason: "below the vault's minimum deposit: BelowMinDeposit(50000000, 100000000)" }),
        q("vrpcw", { exitDays: 1 }),
        q("prnh", { asyncDeposit: true }),
        q("pgain", { apy: { d7: 34, d30: -11 } }),
        q("sharpbyte", { exitLiquidity: 10 }),
        q("roxusdc", { minDeposit: 100 }),
        q("gpci", { status: "closed", reason: "the vault is paused: OperationPaused" }),
        q("bfbtc", { status: "closed", reason: venue("bfbtc").why }),
        q("axilpot", { apy: {} }),
      ],
      cond({ maxExitDays: 0, allowAsyncDeposit: false, stableOnly: true }),
    );
    const why = Object.fromEntries(r.excluded.map((e) => [e.quote.venue.id, e.why]));
    assert.equal(r.ranked.length, 0);
    assert.match(why.vrpcs, /BelowMinDeposit/);
    assert.match(why.vrpcw, /after 1 day\(s\), you want it within 0/);
    assert.match(why.prnh, /deposit is a request/);
    assert.match(why.pgain, /share price fell/);
    assert.match(why.sharpbyte, /only 10 USDC can leave/);
    assert.match(why.roxusdc, /minimum deposit is 100/);
    assert.match(why.gpci, /paused.*Harbor: KYB required/);
    assert.equal(why.bfbtc, venue("bfbtc").why);
    assert.match(why.axilpot, /no yield history/);
    assert.match(r.explanation[0], /No Harbor venue fits/);
  });

  it("skips venues Harbor marks as not for the user's region", () => {
    const r = route([q("sharpbyte"), q("roxusdc", { apy: { d7: 1, d30: 1 } })], cond({ region: "US" }));
    assert.deepEqual(r.ranked.map((x) => x.quote.venue.id), ["roxusdc"]);
    assert.match(r.excluded[0].why, /not for US/);
  });

  it("compares the rest when a venue is down, and says so", () => {
    const r = route([q("roxusdc", { status: "down", reason: "RockawayX USDC (roxUSDC): no answer in 25000 ms" }), q("sharpbyte")], cond());
    assert.equal(r.ranked[0].quote.venue.id, "sharpbyte");
    assert.equal(r.down.length, 1);
    assert.match(r.explanation.join(" "), /1 venue\(s\) didn't answer/);
  });
});

describe("failure isolation", () => {
  it("one venue that hangs or throws is down, the others still answer", async () => {
    const ctx = {} as Ctx;
    const quoter = async (_c: Ctx, v: Venue): Promise<Quote> => {
      if (v.id === "roxusdc") return new Promise<Quote>(() => {}); // never answers
      if (v.id === "vrpcw") throw new Error("HTTP request failed: 502");
      return q(v.id);
    };
    const t0 = Date.now();
    const qs = await quoteAll(ctx, PROBE, 1_000_000n, { ...DEFAULTS, venue_timeout_ms: 200 }, VENUES, quoter);
    assert.ok(Date.now() - t0 < 2000);
    const by = Object.fromEntries(qs.map((x) => [x.venue.id, x]));
    assert.equal(qs.length, 16);
    assert.equal(by.roxusdc.status, "down");
    assert.match(by.roxusdc.reason!, /no answer in 200 ms/);
    assert.equal(by.vrpcw.status, "down");
    assert.match(by.vrpcw.reason!, /502/);
    assert.equal(qs.filter((x) => x.status === "open").length, 14);
  });
});

describe("reverts", () => {
  it("knows the errors the Harbor vaults revert with (selectors seen on chain)", () => {
    const seen: Record<string, string> = {
      "BelowMinDeposit(uint256,uint256)": "0x0267cc62",
      "BelowMinDeposit(address,uint256,uint256)": "0x443c8a40",
      "OperationPaused()": "0x332c3700",
      "InsufficientNativeFee(uint256,uint256)": "0xa59beae2",
      "TransferNotAllowed()": "0x8cd22d19",
      "ExceedsMaxDeposit()": "0xe4bac01b",
      "InsufficientAmount()": "0x5945ea56",
      "BelowMinimumRequest()": "0xff96b341",
      "InsufficientShares()": "0x39996567",
      "UseRedeemShares()": "0xa339e0ec",
    };
    for (const [sig, sel] of Object.entries(seen)) assert.equal(toFunctionSelector(`function ${sig}`), sel, sig);
  });

  it("turns revert data into a readable reason", () => {
    const data = encodeErrorResult({ abi: ERRORS, errorName: "BelowMinDeposit", args: [50_000_000n, 100_000_000n] });
    assert.equal(explainRevert(data), "below the vault's minimum deposit: BelowMinDeposit(50000000, 100000000)");
    assert.equal(explainRevert("0x332c3700"), "the vault is paused: OperationPaused");
    assert.equal(explainRevert("0xa80f75ab"), "custom error 0xa80f75ab");
    assert.equal(explainRevert(undefined, "execution reverted: ERC20: transfer amount exceeds allowance"), "ERC20: transfer amount exceeds allowance");
    assert.equal(explainRevert("0x", "execution reverted: "), "reverted with no reason");
  });
});

describe("state overrides", () => {
  it("writes USDC balance and allowance into their mapping slots (9 and 10)", () => {
    const [o] = tokenOverride(USDC, ME, { balance: 5n, spender: PROBE, allowance: 7n });
    const balSlot = keccak256(concat([pad(ME), pad(toHex(9))]));
    const allowSlot = keccak256(concat([pad(PROBE), keccak256(concat([pad(ME), pad(toHex(10))]))]));
    assert.deepEqual(o.stateDiff, [
      { slot: balSlot, value: pad(toHex(5n)) },
      { slot: allowSlot, value: pad(toHex(7n)) },
    ]);
  });

  it("packs Morpho collateral above the borrow shares, one slot after the position's base", () => {
    const id = `0x${"ab".repeat(32)}` as Hex;
    const [o] = morphoCollateralOverride(PROBE, id, ME, 3n, 2n);
    const base = BigInt(keccak256(concat([pad(ME), keccak256(concat([id, pad(toHex(2))]))])));
    assert.equal(o.stateDiff![0].slot, pad(toHex(base + 1n)));
    assert.equal(BigInt(o.stateDiff![0].value), (3n << 128n) | 2n);
  });

  it("merges overrides of the same contract into one entry", () => {
    const m = mergeOverrides(tokenOverride(USDC, ME, { balance: 1n }), tokenOverride(USDC, ME, { spender: PROBE, allowance: 1n }));
    assert.equal(m.length, 1);
    assert.equal(m[0].stateDiff!.length, 2);
  });
});

describe("transactions", () => {
  it("deposits directly or as a request, depending on the vault", () => {
    const [approve, dep] = depositSteps(venue("sharpbyte"), ME, 1_000_000n);
    assert.equal(approve.to, USDC);
    assert.deepEqual(decodeFunctionData({ abi: VAULT, data: dep.data }).args, [1_000_000n, ME]);
    const [, req] = depositSteps(venue("prnh"), ME, 1_000_000n);
    const d = decodeFunctionData({ abi: VAULT, data: req.data });
    assert.equal(d.functionName, "requestDeposit");
    assert.deepEqual(d.args, [1_000_000n, ME, ME]);
  });

  it("redeems at once or files a request that carries the vault's PROS fee", () => {
    const [r] = withdrawSteps(venue("roxusdc"), ME, 10n);
    assert.equal(decodeFunctionData({ abi: VAULT, data: r.data }).functionName, "redeem");
    const [rq] = withdrawSteps(venue("vrpcs"), ME, 10n, 300_000_000_000_000n);
    assert.equal(decodeFunctionData({ abi: VAULT, data: rq.data }).functionName, "requestRedeem");
    assert.equal(rq.value, 300_000_000_000_000n);
  });
});

describe("plan check", () => {
  it("simulates each step on top of what the earlier steps leave behind", async () => {
    const seen: number[] = [];
    // A chain where the deposit only passes if an allowance override is present.
    const client = {
      call: async (a: { data: Hex; stateOverride?: unknown[] }) => {
        seen.push(a.stateOverride?.length ?? 0);
        if (a.data.startsWith(toFunctionSelector("function deposit(uint256,address)")) && !a.stateOverride?.length) {
          throw Object.assign(new Error("execution reverted"), { data: encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["ERC20: transfer amount exceeds allowance"] }) });
        }
        return { data: "0x" };
      },
    } as unknown as PublicClient;
    const steps: Step[] = depositSteps(venue("sharpbyte"), ME, 1_000_000n);
    const without = await checkPlan(client, ME, steps);
    assert.equal(without[1].ok, false);
    assert.equal(without[1].reason, "ERC20: transfer amount exceeds allowance");
    steps[0].after = tokenOverride(USDC, ME, { spender: venue("sharpbyte").address, allowance: 1_000_000n });
    const withAfter = await checkPlan(client, ME, steps);
    assert.ok(withAfter.every((c) => c.ok));
    assert.deepEqual(seen.slice(-2), [0, 1]);
  });
});

describe("requests", () => {
  // The Axil Pot redemption request sent on 2026-11-01 (tx 0x32f982e7...): a share transfer, then RedeemRequest id 18.
  const AXIL = "0x921974d7b1a2dbaccaf5ba893a3a1500638cea6b" as Address;
  const me = pad(ME.toLowerCase() as Hex);
  const logs = [
    { address: "0x13282289b8b241cf16eb5b8bad401c7c2fdab0f8" as Address, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", me, pad(AXIL)] as Hex[], data: pad("0x1b7fd136a616bdb7") },
    { address: AXIL, topics: ["0x1fdc681a13d8c5da54e301c7ce6542dcde4581e4725043fdab2db12ddc574506", me, me, pad("0x12")] as Hex[], data: concat([me, pad("0x1b7fd136a616bdb7")]) },
  ];

  it("finds the request id in a receipt, whatever number the vault gives it", () => {
    assert.deepEqual(requestsIn(logs), [{ vault: getAddress(AXIL), type: "redeem", id: "18", controller: ME }]);
  });

  it("gives positions the ids this wallet filed in that vault, from the journal", () => {
    const rows = [
      { event: "plan" },
      { event: "sent", txs: [{ hash: "0x1" }, { hash: "0x2", requests: requestsIn(logs) }] },
      { event: "sent", txs: [{ requests: [{ vault: AXIL, type: "redeem", id: "7", controller: "0x0000000000000000000000000000000000000001" }] }] },
    ];
    assert.deepEqual(journalRequestIds(rows, AXIL, ME), [18n]);
    assert.deepEqual(journalRequestIds(rows, USDC, ME), []);
  });
});

describe("loan math", () => {
  it("LTV and liquidation price", () => {
    const h = health(50_000_000_000_000_000n, 5_000n, { price: 0.5, lltv: 0.385 }); // 0.05 WPROS, 0.005 USDC
    assert.equal(h.ltv.toFixed(4), "0.2000");
    assert.equal(h.liquidationPrice.toFixed(4), (0.005 / (0.05 * 0.385)).toFixed(4));
    assert.equal(health(0n, 5_000n, { price: 0.5, lltv: 0.385 }).ltv, Infinity);
  });

  it("annualizes share-price growth", () => {
    assert.equal(annualize(1010n, 1000n, 365 * 86400)!.toFixed(4), "1.0000");
    assert.equal(annualize(1000n, 0n, 86400), undefined);
  });
});

describe("rpc", () => {
  it("retries when the node throttles, and passes a revert straight through", async () => {
    const answers = [
      { error: { code: -32011, message: "cu limit exceeded; Request too fast per second." } },
      { result: "0x10" },
      { error: { code: 3, message: "execution reverted: ", data: "0x332c3700" } },
    ];
    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...answers[calls++] }))) as typeof fetch;
    try {
      const req = rpcRequest("http://rpc.test");
      assert.equal(await req({ method: "eth_blockNumber" }), "0x10");
      assert.equal(calls, 2);
      await assert.rejects(req({ method: "eth_call" }), (e: { code: number; data: string }) => e.code === 3 && e.data === "0x332c3700");
      assert.equal(calls, 3);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe("registry", () => {
  it("covers all 16 Harbor assets once", () => {
    assert.equal(VENUES.length, 16);
    assert.equal(new Set(VENUES.map((v) => v.harborId)).size, 16);
    assert.equal(new Set(VENUES.map((v) => v.id)).size, 16);
  });
});
