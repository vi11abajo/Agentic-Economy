// Serves the Prosperion MCP to Hermes on loopback only. Stateless Streamable HTTP: a fresh server and transport
// per request (same as prosper-monitor), so nothing from one question leaks into the next.
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createProsperionMcp, type McpDeps } from "./mcp.js";

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

export async function startMcpHttp(deps: McpDeps, port: number, host = "127.0.0.1") {
  const http = createServer(async (req, res) => {
    try {
      if (new URL(req.url ?? "/", "http://local").pathname !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "stateless MCP: use POST" }, id: null }));
        return;
      }
      const server = createProsperionMcp(deps);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => { void transport.close(); void server.close(); });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
    } catch (err) {
      console.error(`[mcp] ${err instanceof Error ? err.stack : err}`);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "internal error" }));
    }
  });
  await new Promise<void>((r) => http.listen(port, host, r));
  return {
    port: (http.address() as AddressInfo).port,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}
