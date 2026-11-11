import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcRequest } from "./chain.js";

test("waits out the node's 'too fast' answer and still passes real reverts through", async () => {
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
    await assert.rejects(req({ method: "eth_call" }), (e: any) => e.code === 3 && e.data === "0x332c3700");
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = real;
  }
});
