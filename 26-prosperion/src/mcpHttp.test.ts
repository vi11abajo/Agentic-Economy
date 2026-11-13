import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpHttp } from "./mcpHttp.js";

test("the MCP answers over plain HTTP on loopback, the way Hermes will call it", async () => {
  const srv = await startMcpHttp({ listLaunches: () => [], prepareBuy: async () => ({ ok: false, refusal: "test" }) }, 0);
  try {
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${srv.port}/mcp`)));
    assert.equal((await client.listTools()).tools.length, 14);
    await client.close();
    const get = await fetch(`http://127.0.0.1:${srv.port}/mcp`);
    assert.equal(get.status, 405);
  } finally {
    await srv.close();
  }
});
