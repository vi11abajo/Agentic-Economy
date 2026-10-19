// Re-checks, against the live services, every docs gap found during the Docs MCP onboarding (see README.md).
// Read-only, no keys. Usage: npm run verify
import { PharosMcp } from "@agentic-economy/pharos-mcp";
import { rpcProviders } from "./parse.js";

const RPC = "https://rpc.pharos.xyz";
const USDC = "0xc879c018db60520f4355c26ed1a6d572cdac1815";

async function rpc<T>(method: string, params: unknown[]): Promise<{ result?: T; error?: { message: string } }> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return (await res.json()) as { result?: T; error?: { message: string } };
}

const status = async (url: string) => (await fetch(url, { method: "GET", redirect: "follow" })).status;
const line = (ok: boolean, text: string) => console.log(`${ok ? "✓" : "✗"} ${text}`);

async function main(): Promise<void> {
  // Gap 2: the Docs MCP says get_logs has no block timestamp.
  const mcp = new PharosMcp("docs-gap-check");
  await mcp.connect();
  const head = Number((await mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber);
  const logs = await mcp.call<Record<string, unknown>[]>("get_logs", {
    address: USDC,
    fromBlock: `0x${(head - 300).toString(16)}`,
    toBlock: `0x${(head - 5).toString(16)}`,
  });
  await mcp.close();
  const withTime = logs.filter((l) => "blockTimestamp" in l).length;
  line(withTime > 0 && withTime === logs.length,
    `Pharos MCP get_logs: ${withTime}/${logs.length} logs carry blockTimestamp (docs: "get_logs does not include the block timestamp")`);

  // Gap 6: the JSON-RPC docs say eth_getLogs range "100 blocks (rate limited) or 10,000 (fallback)".
  const bn = Number.parseInt((await rpc<string>("eth_blockNumber", [])).result ?? "0x0", 16);
  for (const blocks of [101, 1001]) {
    const r = await rpc<unknown[]>("eth_getLogs", [{
      address: USDC, fromBlock: `0x${(bn - 10 - blocks + 1).toString(16)}`, toBlock: `0x${(bn - 10).toString(16)}`,
    }]);
    console.log(`  rpc.pharos.xyz eth_getLogs over ${blocks} blocks: ${r.error ? `rejected (${r.error.message})` : `ok (${(r.result ?? []).length} logs)`}`);
  }

  // Gap 1: the llms.txt link that ai.pharos.xyz shows vs. the one that works.
  const [agentCenter, docsLlms] = await Promise.all([
    status("https://www.pharos.xyz/agent-center/llms.txt"),
    status("https://docs.pharos.xyz/llms.txt"),
  ]);
  line(agentCenter !== 200 && docsLlms === 200,
    `llms.txt: www.pharos.xyz/agent-center/llms.txt → ${agentCenter}, docs.pharos.xyz/llms.txt → ${docsLlms}`);

  // Gap 5: the Docs MCP agent recommended QuickNode; the RPC page lists only ZAN, Nirvana and Alchemy.
  const rpcPage = await (await fetch("https://docs.pharos.xyz/tooling-and-infrastructure/rpc.md")).text();
  const providers = rpcProviders(rpcPage);
  line(!/quicknode/i.test(rpcPage), `docs RPC providers: ${providers.join(", ")}, no QuickNode`);

  // ...and QuickNode's own public docs don't list Pharos either.
  const ua = { headers: { "user-agent": "Mozilla/5.0" } };
  const qnIndex = await (await fetch("https://www.quicknode.com/docs/llms.txt", ua)).text();
  const qnPage = (await fetch("https://www.quicknode.com/docs/pharos", ua)).status;
  line(!/pharos/i.test(qnIndex) && qnPage === 404,
    `QuickNode docs: ${/pharos/i.test(qnIndex) ? "mention" : "no mention of"} Pharos in docs/llms.txt, quicknode.com/docs/pharos → ${qnPage}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
