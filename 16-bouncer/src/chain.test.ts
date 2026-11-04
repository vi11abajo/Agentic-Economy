import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fromTape, rpcChain, taped, type Chain, type Frame, type Tape } from "./chain.js";

const WALLET = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb";
const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0";

// A fake node: answers from a script of JSON-RPC bodies, one per request, and keeps what it was sent.
function scriptedNode(bodies: unknown[]) {
  const sent: Array<{ method: string; params: unknown[] }> = [];
  const fetch = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    const body = bodies[Math.min(sent.length - 1, bodies.length - 1)];
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch, sent };
}

const depositFrame: Frame = { type: "CALL", from: WALLET, to: WPROS, value: "0x1", input: "0xd0e30db0", logs: [{ address: WPROS, topics: ["0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c"], data: "0x01" }] };

describe("rpcChain", () => {
  it("asks for a callTracer trace with logs, at the block we name", async () => {
    const node = scriptedNode([{ jsonrpc: "2.0", id: 1, result: depositFrame }]);
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} });
    const frame = await chain.trace({ from: WALLET, to: WPROS, data: "0xd0e30db0", value: 1n }, 22100000n);
    assert.deepEqual(frame, depositFrame);
    assert.equal(node.sent[0].method, "debug_traceCall");
    assert.deepEqual(node.sent[0].params, [{ from: WALLET, to: WPROS, data: "0xd0e30db0", value: "0x1" }, "0x1513820", { tracer: "callTracer", tracerConfig: { withLog: true } }]);
  });

  it("waits out the rate limit instead of calling it a failure", async () => {
    const busy = { jsonrpc: "2.0", id: 1, error: { code: -32011, message: "cu limit exceeded" } };
    const node = scriptedNode([busy, { jsonrpc: "2.0", id: 1, result: "0x10" }]);
    const naps: number[] = [];
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async (ms) => void naps.push(ms) });
    assert.equal(await chain.blockNumber(), 16n);
    assert.deepEqual(naps, [1500]);
  });

  it("treats a wallet too poor for the value as 'no gas amount works', not as a broken node", async () => {
    // What Pharos really answered on 2026-11-04 for a 1 PROS buy from a wallet holding 0.039.
    const node = scriptedNode([{ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "The caller does not have enough funds for value transfer." } }]);
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} });
    assert.equal(await chain.estimateGas({ from: WALLET, to: WPROS, data: "0xd0e30db0", value: 10n ** 18n }, 5n), null);
  });

  it("reads code and balance at the block it's told, not at latest", async () => {
    const node = scriptedNode([{ jsonrpc: "2.0", id: 1, result: "0x6080" }, { jsonrpc: "2.0", id: 1, result: "0x2a" }]);
    const chain = rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} });
    assert.equal(await chain.code(WPROS, 5n), "0x6080");
    assert.equal(await chain.balance(WALLET, 5n), 42n);
    assert.deepEqual(node.sent.map((s) => s.params[1]), ["0x5", "0x5"]);
  });
});

describe("tapes", () => {
  it("replay exactly what the real chain said, bigints included", async () => {
    const node = scriptedNode([{ jsonrpc: "2.0", id: 1, result: depositFrame }, { jsonrpc: "2.0", id: 1, result: "0x2a" }]);
    const tape: Tape = {};
    const live: Chain = taped(rpcChain("http://node", { fetch: node.fetch, sleep: async () => {} }), tape);
    const tx = { from: WALLET, to: WPROS, data: "0xd0e30db0", value: 1n } as const;
    await live.trace(tx, 7n);
    await live.balance(WALLET, 7n);
    const offline = fromTape(JSON.parse(JSON.stringify(tape)));
    assert.deepEqual(await offline.trace(tx, 7n), depositFrame);
    assert.equal(await offline.balance(WALLET, 7n), 42n);
    await assert.rejects(offline.balance(WALLET, 8n), /not on the tape/);
  });
});
