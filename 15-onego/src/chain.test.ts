import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromTape, rpcChain, taped, type Chain, type Tape } from "./chain.js";

const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

// A fake node: answers from a script of JSON-RPC bodies, one per request, and remembers how often it was asked.
function scriptedFetch(bodies: unknown[]) {
  let asked = 0;
  const fetch = (async () => {
    const body = bodies[Math.min(asked++, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof globalThis.fetch;
  return { fetch, asked: () => asked };
}

describe("rpcChain", () => {
  it("waits out the rate limit instead of calling it a failure", async () => {
    const busy = { jsonrpc: "2.0", id: 1, error: { code: -32011, message: "cu limit exceeded" } };
    const node = scriptedFetch([busy, busy, { jsonrpc: "2.0", id: 1, result: "0x10" }]);
    const naps: number[] = [];
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async (ms) => void naps.push(ms) });
    assert.equal(await chain.blockNumber(), 16n);
    assert.equal(node.asked(), 3);
    assert.deepEqual(naps, [1500, 1500]);
  });

  it("turns a revert into an answer, not an exception", async () => {
    const data = "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000046e6f706500000000000000000000000000000000000000000000000000000000";
    const node = scriptedFetch([{ jsonrpc: "2.0", id: 1, error: { code: 3, message: "execution reverted: nope", data } }]);
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} });
    const r = await chain.call({ to: MC3, data: "0x" });
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.revertData, data);
  });

  it("gives up on a node that stays busy, loudly", async () => {
    const node = scriptedFetch([{ jsonrpc: "2.0", id: 1, error: { code: -32011, message: "cu limit exceeded" } }]);
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} });
    await assert.rejects(chain.blockNumber(), /cu limit/);
  });
});

describe("tapes", () => {
  it("replays what was recorded, bigints included", async () => {
    const tape: Tape = {};
    const real = { blockNumber: async () => 22038151n, balance: async () => 5n * 10n ** 18n } as unknown as Chain;
    const rec = taped(real, tape);
    await rec.blockNumber();
    await rec.balance(MC3);
    const again = fromTape(JSON.parse(JSON.stringify(tape)));
    assert.equal(await again.blockNumber(), 22038151n);
    assert.equal(await again.balance(MC3), 5n * 10n ** 18n);
  });

  it("refuses to make up an answer that isn't on the tape", async () => {
    await assert.rejects(fromTape({}).code(MC3), /not on the tape/);
  });
});
