// These run against Pharos mainnet on purpose: the whole point of the map is that it agrees with the chain today.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadProtocol, ProtocolDrift, checkMap } from "./protocol.js";

test("the map from Prosper's API agrees with the chain", async () => {
  const p = await loadProtocol();
  assert.equal(p.factory.toLowerCase(), "0xefdbb0ea7647b0e21aef7a3b7a5d6a632c3116c8");
  assert.equal(p.usdc.toLowerCase(), "0xc879c018db60520f4355c26ed1a6d572cdac1815");
  assert.match(p.marketImpl, /^0x[0-9a-fA-F]{40}$/);
  assert.notEqual(p.marketImpl, "0x0000000000000000000000000000000000000000");
  assert.ok(p.block > 22_750_000n, `block ${p.block}`);
});

test("a factory that is not the one we pinned is called out by name", async () => {
  const p = await loadProtocol();
  const swapped = { ...p.deployment, prosperFactory: p.usdc };
  await assert.rejects(checkMap(swapped), (e: any) => e instanceof ProtocolDrift && e.field === "prosperFactory");
});
