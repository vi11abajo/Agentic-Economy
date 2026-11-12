import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProsperionMcp } from "./mcp.js";

const prepared: any[] = [];
async function connect() {
  const server = createProsperionMcp({ listLaunches: () => [], prepareBuy: async (i: any) => (prepared.push(i), { ok: true, id: "abc", url: "https://x/sign/?r=abc" }) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);

test("the agent sees our nine reads plus one tool that only prepares a link for the visitor to sign", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "list_vaults", "market_check", "nav_move", "oracle_freshness", "position", "prepare_buy", "protocol_map",
    "recent_launches", "reward_unlock", "vault_picture",
  ]);
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
