import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeFunctionData, erc20Abi, parseEther, type Address } from "viem";
import { ROUTER_ABI, TRADE_ROUTER, parseSellAmount, prepareSell, sellQuote, sellTxs, type SellReader, type SellState } from "./sell.js";
import { openStore } from "./store.js";

const MARKET = "0xBB3DC336E9221be62cc63e62E3969580B5BAB82c" as Address;
const PTOKEN = "0x05457dA2c193ce92C1877ec2B9eA3966bD54fafE" as Address;
const ME = "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb" as Address;
// pANTA as one real wallet held it at block 22,978,372
const BALANCE = parseEther("208818.1595");

// a curve that pays 1 PROS per 21,305 tokens minus a 1% fee, enough to check the plumbing
function reader(over: Partial<SellState> = {}): SellReader {
  return async (_m, _o, pick) => {
    const s: SellState = {
      market: MARKET, block: 22_978_372n, genuine: true, phase: 0, pToken: PTOKEN, symbol: "pANTA", decimals: 18,
      balance: BALANCE, allowance: 0n, amount: 0n, quote: null, ...over,
    };
    s.amount = pick(s.balance, s.decimals);
    if (s.phase === 0 && s.amount > 0n && s.amount <= s.balance) {
      const gross = s.amount / 21_305n;
      s.quote = { gross, fee: gross / 100n, net: gross - gross / 100n };
    }
    return s;
  };
}

test("words the agent turns into all, a share or a number come out exact on the balance", () => {
  assert.deepEqual(parseSellAmount("all", BALANCE), { amount: BALANCE, percent: 100 });
  assert.deepEqual(parseSellAmount("100%", BALANCE), { amount: BALANCE, percent: 100 });
  assert.deepEqual(parseSellAmount("50%", BALANCE), { amount: parseEther("104409.07975"), percent: 50 });
  assert.deepEqual(parseSellAmount(" 25 % ", BALANCE), { amount: parseEther("52204.539875"), percent: 25 });
  assert.deepEqual(parseSellAmount("33.33%", 10_000n), { amount: 3333n, percent: 33.33 });
  assert.deepEqual(parseSellAmount("1,000", BALANCE), { amount: parseEther("1000"), percent: null });
  assert.ok("error" in parseSellAmount("half", BALANCE), "words are the agent's job, not the server's");
  assert.ok("error" in parseSellAmount("0%", BALANCE));
  assert.ok("error" in parseSellAmount("150%", BALANCE));
  assert.ok("error" in parseSellAmount("-5", BALANCE));
});

test("a quote shows the balance, the exact amount, the share and the PROS, and says if an approve comes first", async () => {
  const q = await sellQuote(reader(), MARKET, ME, "50%");
  assert.ok(q.ok);
  if (!q.ok) return;
  assert.equal(q.symbol, "pANTA");
  assert.equal(q.balanceTokens, "208818.1595");
  assert.equal(q.amountTokens, "104409.07975");
  assert.equal(q.sharePct, 50);
  assert.equal(q.approveNeeded, true);
  assert.ok(Number(q.minNetPros) < Number(q.netPros), "the floor sits below the quote");
  const odd = await sellQuote(reader({ balance: BALANCE + 1n }), MARKET, ME, "50%");
  assert.ok(odd.ok && odd.sharePct === 50, "half of an odd balance still reads 50%");
  const approved = await sellQuote(reader({ allowance: BALANCE }), MARKET, ME, "all");
  assert.ok(approved.ok && !approved.approveNeeded);
});

test("a quote refuses what cannot be sold on the curve, in words", async () => {
  const say = async (r: SellReader, spec: string) => { const q = await sellQuote(r, MARKET, ME, spec); return q.ok ? "" : q.refusal; };
  assert.match(await say(reader(), "300000"), /more than the wallet holds: 208818\.1595 pANTA/);
  assert.match(await say(reader({ balance: 0n }), "all"), /holds no pANTA/);
  assert.match(await say(reader({ phase: 2 }), "all"), /graduated: it trades on FaroSwap/);
  assert.match(await say(reader({ genuine: false, pToken: null }), "all"), /Not a Prosper market/);
  assert.match(await say(reader(), "a lot"), /Could not read "a lot"/);
});

test("prepare_sell saves exactly the confirmed amount and refuses when the wallet holds less now", async () => {
  const store = openStore(":memory:");
  const r = await prepareSell(store, reader(), { market: MARKET, owner: ME, amountTokens: "104409.07975", source: "agent" });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.match(r.url, /\/sign\/\?r=/);
  const saved = store.getRequest(r.id)!;
  assert.equal(saved.kind, "sell");
  assert.equal(saved.params.amountTokens, "104409.07975");
  assert.equal(saved.params.pToken, PTOKEN);
  const less = await prepareSell(store, reader({ balance: parseEther("100") }), { market: MARKET, owner: ME, amountTokens: "104409.07975", source: "agent" });
  assert.ok(!less.ok && /more than the wallet holds/.test(less.refusal));
  const vague = await prepareSell(store, reader(), { market: MARKET, owner: ME, amountTokens: "50%", source: "agent" });
  assert.ok(!vague.ok && /exact number of tokens/.test(vague.refusal), "a share is for sell_quote, prepare_sell takes the number it returned");
});

test("the transactions: approve exactly this amount to the router, then sellInner paying native PROS", async () => {
  const s = await reader()(MARKET, ME, () => parseEther("1000"));
  const t = sellTxs(s, 1_800_000_000);
  assert.ok(!("refusal" in t));
  if ("refusal" in t) return;
  assert.equal(t.approve!.to, PTOKEN);
  const ap = decodeFunctionData({ abi: erc20Abi, data: t.approve!.data });
  assert.deepEqual(ap.args, [TRADE_ROUTER, parseEther("1000")]);
  assert.equal(t.sell.to, TRADE_ROUTER);
  const sl = decodeFunctionData({ abi: ROUTER_ABI, data: t.sell.data });
  assert.equal(sl.functionName, "sellInner");
  const [market, amount, minOut, deadline, nativeOut] = sl.args;
  assert.equal(market, MARKET);
  assert.equal(amount, parseEther("1000"));
  assert.equal(minOut, (s.quote!.net * 9800n) / 10_000n);
  assert.equal(deadline, 1_800_000_600n);
  assert.equal(nativeOut, true);
  const already = sellTxs({ ...s, allowance: parseEther("1000") }, 1_800_000_000);
  assert.ok(!("refusal" in already) && already.approve === null, "no approve when the router may already take them");
});
