// HTTP entry point: public feed (terminal page + SSE), our MCP endpoint (Streamable HTTP, stateless) and the
// indexer + Telegram bot running in the same process. Per-IP rate limit on every endpoint.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { Indexer } from "./indexer.js";
import { EXPLORER, type TradeRow } from "./prosper.js";
import { startTelegram } from "./telegram.js";
import { createMcpServer } from "./tools.js";

const db = openDb(config.dbPath);
const indexer = new Indexer(db);
const feedHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "public", "feed.html"), "utf8")
  .replaceAll("{{BASE}}", config.basePath)
  .replaceAll("{{PUBLIC_URL}}", config.publicUrl);

// ---- per-IP fixed-window rate limit (Cloudflare passes the client IP in CF-Connecting-IP)
const buckets = new Map<string, { count: number; start: number }>();
function clientIp(req: IncomingMessage): string {
  return (req.headers["cf-connecting-ip"] as string) ?? (req.headers["x-real-ip"] as string) ?? req.socket.remoteAddress ?? "?";
}
function allow(req: IncomingMessage, res: ServerResponse): boolean {
  const ip = clientIp(req);
  const now = Date.now();
  const b = buckets.get(ip);
  if (!b || now - b.start > 60_000) {
    buckets.set(ip, { count: 1, start: now });
    return true;
  }
  if (++b.count <= config.rateLimitPerMinute) return true;
  res.writeHead(429, { "retry-after": String(Math.ceil((b.start + 60_000 - now) / 1000)), "content-type": "application/json" });
  res.end(JSON.stringify({ error: "Too Many Requests" }));
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) if (now - b.start > 60_000) buckets.delete(ip);
}, 60_000).unref();

// ---- live feed (Server-Sent Events)
const streams = new Set<ServerResponse>();
const perIpStreams = new Map<string, number>();
const sse = (res: ServerResponse, event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
const feedTrade = (t: TradeRow) => ({ ...t, url: `${EXPLORER}/tx/${t.tx}` });
indexer.on("trade", (t: TradeRow) => {
  for (const res of streams) sse(res, "trade", feedTrade(t));
});
indexer.on("market", (m) => {
  for (const res of streams) sse(res, "market", m);
});
indexer.on("phase", (m) => {
  for (const res of streams) sse(res, "phase", { symbol: m.symbol, market: m.market, label: m.label });
});
setInterval(() => {
  for (const res of streams) sse(res, "status", indexer.status);
}, 10_000).unref();

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : undefined;
}

const http = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://local");
    const path = url.pathname.replace(/\/$/, "") || "/";
    const base = config.basePath;

    if (path === "/" || path === "") {
      res.writeHead(302, { location: `${base}` });
      return res.end();
    }
    if (path === "/healthz") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(indexer.status));
    }
    if (path === base && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
      return res.end(feedHtml);
    }
    if (path === `${base}/stream` && req.method === "GET") {
      const ip = clientIp(req);
      if ((perIpStreams.get(ip) ?? 0) >= 5) {
        res.writeHead(429);
        return res.end();
      }
      perIpStreams.set(ip, (perIpStreams.get(ip) ?? 0) + 1);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-accel-buffering": "no" });
      sse(res, "status", indexer.status);
      sse(res, "markets", indexer.allMarkets().map((m) => ({ symbol: m.symbol, name: m.name, market: m.market, slug: m.vault.slice(-6).toLowerCase() })));
      sse(res, "history", db.trades({ markets: indexer.onCurveIds(), limit: 60 }).reverse().map(feedTrade));
      streams.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
      req.on("close", () => {
        clearInterval(ping);
        streams.delete(res);
        perIpStreams.set(ip, Math.max(0, (perIpStreams.get(ip) ?? 1) - 1));
      });
      return;
    }
    if (path === `${base}/trades.json` && req.method === "GET") {
      if (!allow(req, res)) return;
      const token = url.searchParams.get("market") ?? undefined;
      res.writeHead(200, { "content-type": "application/json" });
      const onCurve = indexer.onCurveIds();
      const market = token && onCurve.includes(token.toLowerCase()) ? token.toLowerCase() : undefined;
      return res.end(JSON.stringify(db.trades({ market, markets: market ? undefined : onCurve, limit: Number(url.searchParams.get("limit") ?? 50) }).map(feedTrade)));
    }
    if (path === `${base}/mcp`) {
      if (!allow(req, res)) return;
      if (req.method !== "POST") {
        res.writeHead(405, { allow: "POST", "content-type": "application/json" });
        return res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless MCP: use POST)" }, id: null }));
      }
      // Stateless Streamable HTTP: a fresh server + transport per request.
      const server = createMcpServer(db, indexer);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      res.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res, await readBody(req));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("Not found");
  } catch (err) {
    console.error(`[http] ${err instanceof Error ? err.stack : err}`);
    if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "internal error" }));
  }
});

http.listen(config.port, () => console.log(`[http] listening on :${config.port} · feed ${config.basePath} · mcp ${config.basePath}/mcp`));
startTelegram(db, indexer);
void indexer.run();
