import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createProsperionMcp } from "./mcp.js";

async function connect() {
  const server = createProsperionMcp({ listLaunches: () => [] });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const body = (r: any) => JSON.parse(r.content[0].text);

test("the agent sees exactly our nine read-only tools", async () => {
  const c = await connect();
  const names = (await c.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "list_vaults", "market_check", "nav_move", "oracle_freshness", "position", "protocol_map",
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
