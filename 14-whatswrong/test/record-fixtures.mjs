// Snapshots what the chain said about our real failed transactions, so the tests replay true answers offline.
// Run once by hand: node test/record-fixtures.mjs   (talks to mcp.pharos.xyz and rpc.pharos.xyz)
import { writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const crimeScenes = {
  "prosper-slippage": "0xbfe6c7c31de6e40e0c93f08e69025caf62fb1ff1678224208ae969d08259cb69",
  "prosper-out-of-gas": "0x050199ea5c1651022cc8882e062779b7b6ad6479da8425439cd06b275a11c38d",
  "prosper-no-allowance": "0xe8b01dc91222df4f54aa3e07ad25404da394f2e9b32e08eaf9e73eac9bd09586",
  "faroswap-too-little": "0x789d7715e28b80e914cdcf71fb2e16a86f1aa9fdc2aab6cc5c4283cb406adacd",
  "faroswap-same-block": "0x59925ccc327c5f329736bfbbe752ee4a2a3b48561dd4f23995743ddcb34d77cf",
  "faroswap-stf": "0xa9435d844d7d0d3644584f42a4646c6c3db209db4a81127b46133df9fe80386d",
  "faroswap-too-old": "0xc4dabdaba58142ce1313bc1a6c50a388d09dc32f13b97784d1e754bfd356a43b",
  "harbor-vault-dry": "0x3b7aa7df0eafa9432b62b83e47e9ac3040bb27f9af679c5bc0d397829883d205",
  "harbor-deposit-short": "0x3a79b7b623a240ad4354b4bc21adf2a2674e9b5f7be639b8cb95fcf1bb547619",
};

const mcp = new Client({ name: "whatswrong-fixtures", version: "1.0.0" });
await mcp.connect(new StreamableHTTPClientTransport(new URL("https://mcp.pharos.xyz/mcp")));
const askMcp = async (name, args) => {
  const answer = await mcp.callTool({ name, arguments: args });
  const text = answer.content.find((c) => c.type === "text")?.text ?? "";
  return { isError: Boolean(answer.isError), body: JSON.parse(text) };
};
const askRpc = async (method, params) =>
  (await (await fetch("https://rpc.pharos.xyz", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json());
const nap = (ms) => new Promise((r) => setTimeout(r, ms));

for (const [name, hash] of Object.entries(crimeScenes)) {
  const tx = await askMcp("get_transaction", { hash });
  const receipt = await askMcp("get_transaction_receipt", { hash });
  const block = Number(BigInt(tx.body.blockNumber));
  const t = tx.body;
  const replayBefore = await askMcp("eth_call", { transaction: { from: t.from, to: t.to, data: t.input, value: t.value, gas: t.gas }, block: block - 1 });
  const trace = await askRpc("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
  const blockWithTxs = await askMcp("get_block", { block, includeTransactions: true });
  writeFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), JSON.stringify({ hash, tx: tx.body, receipt: receipt.body, replayBefore, trace: trace.result ?? null, block: blockWithTxs.body }, null, 1));
  console.log(name, "block", block, "replay", replayBefore.isError ? "reverts" : "passes", "trace", trace.result ? "ok" : trace.error?.message);
  await nap(1500);
}
await mcp.close();
