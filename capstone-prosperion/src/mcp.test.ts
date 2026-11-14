import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProsperionMcp } from "./mcp.js";
import { openStore } from "./store.js";
import { openTradeBook, type Trade } from "./trades.js";

const prepared: any[] = [];
// Two real pFROG trades: a 19 PROS buy that is still held and a 0.1 PROS one (txs 0xd73c66a5…, 0xb6e9af8c…).
const FROG = "0x8DAA60552dbB856A4EEBC271Ff6783F42e63A26E";
const book = openTradeBook(openStore(":memory:").db);
const t = (tx: string, block: bigint, trader: string, gross: bigint, tokens: bigint): Trade => ({
  market: FROG, block, tx: tx as `0x${string}`, logIndex: 4, kind: "buy", trader: trader as `0x${string}`, caller: "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5",
  prosGross: gross, prosNet: (gross * 99n) / 100n, tokens, fee: gross / 100n,
});
book.save([
  t("0xd73c66a5750a1656ff0ed44e09e961b08429de43e1a25c81c5cca0df5945f004", 22_889_592n, "0x261a31f9bd2789B490bAdF62784D8c58151b1bD2", 19n * 10n ** 18n, 2_499_732n * 10n ** 18n),
  t("0xb6e9af8ce866d27588ca44b98bdb41ddd777586a0a235598d68ca39bf1046e26", 22_939_812n, "0x12b5329b83dbaEE5e80EbaD2F4297bC065e5C43B", 10n ** 17n, 13_123n * 10n ** 18n),
]);
book.setCoverage(22_000_000n, 22_970_000n);

async function connect() {
  const server = createProsperionMcp({ listLaunches: () => [], prepareBuy: async (i: any) => (prepared.push(i), { ok: true, id: "abc", url: "https://x/sign/?r=abc" }), trades: book, head: async () => 22_970_100n });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);

test("the agent sees our fourteen reads plus one tool that only prepares a link for the visitor to sign", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "faroswap_pool", "launch_board", "list_vaults", "market_check", "market_trades", "nav_move", "oracle_freshness", "position", "prepare_buy", "protocol_map",
    "recent_launches", "reward_unlock", "vault_picture", "vault_profile", "wallet_portfolio",
  ]);
});

test("market_trades counts buyers from the index and checks the curve on chain", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "market_trades", arguments: { market: FROG } }));
  assert.equal(r.buys, 2);
  assert.equal(r.buyers, 2);
  assert.equal(r.prosPaidIn, "19.1");
  assert.equal(r.holdersCount, 2);
  assert.equal(r.latest[0].tx, "0xb6e9af8ce866d27588ca44b98bdb41ddd777586a0a235598d68ca39bf1046e26", "newest first");
  assert.equal(r.coverage.blocksBehindHead, "100");
  assert.match(r.reserveCheck.block, /^\d+$/);
  assert.equal(r.reserveCheck.call.data, "0x0172d417");
});

test("launch_board sees every Prosper market, not just the ones the watcher caught", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "launch_board", arguments: { status: "all", limit: 80 } }));
  assert.ok(r.totals.markets >= 70, `markets: ${r.totals.markets}`);
  assert.equal(r.totals.markets, r.totals.onCurve + r.totals.graduated + r.totals.failed);
  const open = body(await c.callTool({ name: "launch_board", arguments: {} })).markets;
  for (let i = 1; i < open.length; i++) assert.ok(Number(open[i - 1].prosInCurve) >= Number(open[i].prosInCurve));
});

test("wallet_portfolio finds a pFROG holder's position in one call", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "wallet_portfolio", arguments: { owner: "0x261a31f9bd2789B490bAdF62784D8c58151b1bD2" } }));
  const frog = r.holdings.find((h: any) => h.symbol === "pFROG");
  assert.ok(frog, JSON.stringify(r.holdings));
  assert.ok(BigInt(frog.balance) > 0n);
});

test("vault_profile labels Prosper's fee numbers as the API's and reads the share price on chain", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "vault_profile", arguments: { vault: "Barker Neutral Carry" } }));
  assert.match(r.fromProsperApi.note, /not read on chain/);
  assert.ok(BigInt(r.onChain.navPerShareUsdc) > 1_000_000n);
});

test("market_check answers with the block it read at", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "market_check", arguments: { market: "0x94228eb493173e75a12e76e667bfe9b0939aae64", amountIn: "1" } }));
  assert.equal(r.genuine, true);
  assert.match(r.block, /^\d+$/);
});

test("reward_unlock says out loud that the unlock rule comes from Prosper's API, not the chain", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "reward_unlock", arguments: { vault: "0x3ed49843a55952a399db99c8949f67a9d821611c" } }));
  assert.equal(r.hypothesis, true);
  assert.equal(typeof r.currentUnlockBps, "number");
  assert.ok(Array.isArray(r.navUnlocks) && r.navUnlocks.length > 0);
  assert.match(r.block, /^\d+$/);
});

test("vault tools take the vault's name, so the agent cannot grab the wrong one of its five addresses", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "oracle_freshness", arguments: { vault: "Barker Neutral Carry" } }));
  assert.equal(r.vault, "0x3Ed49843a55952A399dB99C8949f67a9D821611C");
  assert.match(r.block, /^\d+$/);
});

test("list_vaults narrows to what the agent asked for", async () => {
  const c = await connect();
  const rows = body(await c.callTool({ name: "list_vaults", arguments: { query: "barker neutral" } }));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].vault.toLowerCase(), "0x3ed49843a55952a399db99c8949f67a9d821611c");
});

test("an escrow address gets an answer that says what to pass instead, not a bare revert", async () => {
  const c = await connect();
  const r: any = await c.callTool({ name: "vault_picture", arguments: { vault: "0x8e634f8af1cca10cacb85c23fedd6171a31f7997" } });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not a Prosper vault/i);
  assert.match(r.content[0].text, /name/);
});

test("vault_picture hands over the exact eth_call for the cross-check, so the agent never guesses a selector", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "vault_picture", arguments: { vault: "Barker Neutral Carry" } }));
  const total = r.crossCheck.find((x: any) => x.what === "vault totalAssets()");
  assert.deepEqual(total, { what: "vault totalAssets()", to: r.vault, data: "0x01e1d114", block: r.block, expect: r.totalAssets });
  const supply = r.crossCheck.find((x: any) => x.what === "vault totalSupply()");
  assert.deepEqual(supply, { what: "vault totalSupply()", to: r.vault, data: "0x18160ddd", block: r.block, expect: r.supply });
});

test("market_check hands over the exact eth_call for the reserve cross-check", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "market_check", arguments: { market: "0x94228eb493173e75a12e76e667bfe9b0939aae64", amountIn: "1" } }));
  assert.deepEqual(r.crossCheck, [{ what: "market realWrappedNativeReserve()", to: r.market, data: "0x0172d417", block: r.block, expect: r.reserveBefore }]);
});

test("prepare_buy hands back a sign link and never a transaction", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "prepare_buy", arguments: {
    market: "0x94228eb493173e75a12e76e667bfe9b0939aae64", owner: "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb", amountPros: "0.25",
  } }));
  assert.equal(r.url, "https://x/sign/?r=abc");
  assert.equal(r.data, undefined);
  const sent = prepared.at(-1);
  assert.equal(sent.amountWei, 25n * 10n ** 16n);
  assert.equal(sent.source, "agent");
  assert.equal(sent.owner, "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb");
});

test("faroswap_pool prices a graduated pToken from its pair at one block", async () => {
  const c = await connect();
  const r = body(await c.callTool({ name: "faroswap_pool", arguments: { market: "0x3f603E94053a6F251B4a98c17e26c3e8F65f2BD7" } }));
  assert.equal(r.phase, 2);
  assert.equal(r.pair, "0x0A438d3ecEbb6c4221dD54905C7329975E88584F");
  assert.ok(Number(r.pool.prosInPool) > 0 && Number(r.pool.prosPerMillionTokens) > 0);
  const open = body(await c.callTool({ name: "faroswap_pool", arguments: { market: FROG } }));
  assert.equal(open.pool, null);
});
