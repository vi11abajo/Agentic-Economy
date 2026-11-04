import { test } from "node:test";
import assert from "node:assert/strict";
import { RevertedCall, tapeChain } from "./chain.js";

const PAIR = "0x3fa4fbe561f6d5996ca69b4fb82e61a01d3ae558";
const SWAP = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822";

// Answers copied from the real Chain MCP (2026-11-04), keyed the way the chain layer asks for them.
const tape = {
  "get_block_number {}": { blockNumber: "22133194", blockNumberHex: "0x151b9ca" },
  [`get_logs {"address":["${PAIR}"],"topics":["${SWAP}"],"fromBlock":"0x151b5e3","toBlock":"0x151b9ca"}`]: [
    {
      address: PAIR,
      topics: [SWAP, "0x00000000000000000000000014f06fe99a1264825c99fb1c8e05a90036e89d0a", "0x000000000000000000000000cc1e28073b2ab93b6053cc96f1f0d41e7cb85632"],
      data: "0x01",
      blockNumber: "0x151b3a0",
      logIndex: "0x4",
      transactionHash: "0x2c8fee0ceb589415dbc2fa8ab7f887fb8e9267029c55c223aa4a7c0099ec2e1a",
    },
  ],
  'get_block {"block":"0x151b9cb"}': null,
  'eth_call {"transaction":{"to":"0xc879c018db60520f4355c26ed1a6d572cdac1815","data":"0xa9059cbb"}}': {
    error: { message: "execution reverted: ERC20: transfer from the zero address", code: 3, data: "0x08c379a0" },
  },
};

test("tapeChain answers blockNumber and logs from the tape", async () => {
  const chain = tapeChain(tape);
  assert.equal(await chain.blockNumber(), 22133194n);
  const logs = await chain.logs({ address: [PAIR], topics: [SWAP], from: 22132195n, to: 22133194n });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].blockNumber, 22131616n);
  assert.equal(logs[0].logIndex, 4);
  assert.equal(logs[0].topics[2], "0x000000000000000000000000cc1e28073b2ab93b6053cc96f1f0d41e7cb85632");
});

test("a block that is not there yet comes back as null", async () => {
  assert.equal(await tapeChain(tape).block(22133195n), null);
});

test("a reverted eth_call throws RevertedCall with the reason", async () => {
  const err = await tapeChain(tape).call("0xc879c018db60520f4355c26ed1a6d572cdac1815", "0xa9059cbb").catch((e) => e);
  assert.ok(err instanceof RevertedCall);
  assert.match(err.message, /transfer from the zero address/);
});

test("tapeChain throws on a missing key", async () => {
  await assert.rejects(tapeChain(tape).code("0x46441dc99f8000959e9c48cf2a01a018d131d3bb"), /^Error: no tape for get_code/);
});

test("journal records step and tool", async () => {
  const chain = tapeChain(tape);
  chain.step("pool");
  await chain.blockNumber();
  assert.equal(chain.journal.length, 1);
  assert.equal(chain.journal[0].step, "pool");
  assert.equal(chain.journal[0].tool, "get_block_number");
});
