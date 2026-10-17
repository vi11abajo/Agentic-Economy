// Our MCP server: high-level Prosper tools answered from the indexer's database (no chain calls per request).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Db } from "./db.js";
import type { Indexer } from "./indexer.js";
import { EXPLORER, NATIVE, type MarketRow, type TradeRow } from "./prosper.js";

const MAX_WAIT_SEC = 90; // Cloudflare closes proxied requests after ~100 s

export function createMcpServer(db: Db, indexer: Indexer): McpServer {
  const server = new McpServer(
    { name: "prosper-monitor", version: "1.0.0" },
    {
      instructions:
        "Live data for Prosper (pros-per.xyz) tokens that are still ON the bonding curve on Pharos mainnet (graduated and curve-only tokens are excluded): every buy and sell, " +
        "volumes and prices. Data is indexed from Pharos Chain MCP. Tokens can be given by symbol (pMusk), market or pToken " +
        "address, or the vault suffix from the app URL (sxss-46f0d8 -> 46f0d8). Amounts are in PROS (native token).",
    },
  );

  const resolve = (token?: string): MarketRow | undefined => {
    if (!token) return undefined;
    const t = token.trim().toLowerCase().replace(/^.*-(?=[0-9a-f]{6}$)/, "");
    const all = indexer.allMarkets();
    const hit =
      all.find((m) => m.market === t || m.pToken.toLowerCase() === t || m.vault.toLowerCase() === t) ??
      all.find((m) => m.symbol.toLowerCase() === t || m.name.toLowerCase() === t) ??
      (/^[0-9a-f]{6}$/.test(t) ? all.find((m) => m.vault.toLowerCase().endsWith(t)) : undefined);
    if (!hit) throw new Error(`Unknown token "${token}". Use list_markets to see the available ones.`);
    return hit;
  };
  const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
  const tradeOut = (t: TradeRow) => ({
    side: t.side,
    token: t.symbol,
    trader: t.trader,
    pros: round(t.pros),
    tokens: round(t.tokens),
    price_pros: t.price,
    fee_pros: round(t.fee),
    block: t.block,
    time: new Date(t.time * 1000).toISOString(),
    tx: t.tx,
    url: `${EXPLORER}/tx/${t.tx}`,
  });

  server.registerTool(
    "list_markets",
    { title: "List Prosper markets", description: "Prosper tokens currently ON the bonding curve (graduated and curve-only tokens are excluded), with addresses, PROS raised on the curve and 24h activity." },
    async () => {
      const day = Math.floor(Date.now() / 1000) - 86400;
      return json(indexer.allMarkets().map((m) => {
        const s = db.stats(m.market, day);
        const last = db.lastTrade(m.market);
        return {
          token: m.symbol, name: m.name, slug_suffix: m.vault.slice(-6).toLowerCase(), market: m.market, pToken: m.pToken,
          raised_pros: round(db.netCurvePros(m.market)), trades_24h: s.trades, last_price_pros: last?.price ?? null,
          last_trade: last ? new Date(last.time * 1000).toISOString() : null,
        };
      }));
    },
  );

  server.registerTool(
    "recent_trades",
    {
      title: "Recent trades",
      description: "Latest buys/sells, newest first. Filter by token, trader, side, minimum PROS and time window.",
      inputSchema: {
        token: z.string().optional().describe("Symbol, market/pToken address or app slug; omit for all markets"),
        trader: z.string().optional().describe("Wallet address"),
        side: z.enum(["BUY", "SELL"]).optional(),
        min_pros: z.number().optional(),
        hours: z.number().optional().describe("Only trades from the last N hours"),
        limit: z.number().optional().describe("Max rows (default 20, max 200)"),
      },
    },
    async (a) => {
      const m = resolve(a.token);
      return json(db.trades({
        market: m?.market, markets: m ? undefined : indexer.onCurveIds(), trader: a.trader, side: a.side, minPros: a.min_pros, limit: a.limit,
        sinceTime: a.hours ? Math.floor(Date.now() / 1000 - a.hours * 3600) : undefined,
      }).map(tradeOut));
    },
  );

  server.registerTool(
    "token_stats",
    {
      title: "Token stats",
      description: "Activity of one token: buys/sells, PROS volume and unique traders in the last 1h and 24h, PROS raised on the curve, last price.",
      inputSchema: { token: z.string().describe("Symbol, market/pToken address or app slug") },
    },
    async (a) => {
      const m = resolve(a.token)!;
      const now = Math.floor(Date.now() / 1000);
      const last = db.lastTrade(m.market);
      return json({
        token: m.symbol, name: m.name, market: m.market, pToken: m.pToken,
        created: new Date(m.createdTime * 1000).toISOString(),
        raised_pros: round(db.netCurvePros(m.market)),
        last_price_pros: last?.price ?? null,
        last_1h: db.stats(m.market, now - 3600),
        last_24h: db.stats(m.market, now - 86400),
        all_time: db.stats(m.market, 0),
      });
    },
  );

  server.registerTool(
    "wait_for_trade",
    {
      title: "Wait for the next trade",
      description: `Blocks until the next new buy/sell (optionally for one token and above a PROS size) and returns it; returns {"timeout":true} after timeout_sec (max ${MAX_WAIT_SEC}). Call again to keep watching.`,
      inputSchema: {
        token: z.string().optional(),
        min_pros: z.number().optional(),
        side: z.enum(["BUY", "SELL"]).optional(),
        timeout_sec: z.number().optional().describe(`Default and max ${MAX_WAIT_SEC}`),
      },
    },
    async (a) => {
      const m = resolve(a.token);
      const timeout = Math.min(a.timeout_sec ?? MAX_WAIT_SEC, MAX_WAIT_SEC) * 1000;
      const trade = await new Promise<TradeRow | undefined>((done) => {
        const onTrade = (t: TradeRow) => {
          if (m && t.market !== m.market) return;
          if (a.side && t.side !== a.side) return;
          if (a.min_pros && t.pros < a.min_pros) return;
          clearTimeout(timer);
          indexer.off("trade", onTrade);
          done(t);
        };
        const timer = setTimeout(() => {
          indexer.off("trade", onTrade);
          done(undefined);
        }, timeout);
        indexer.on("trade", onTrade);
      });
      return json(trade ? tradeOut(trade) : { timeout: true, waited_sec: timeout / 1000 });
    },
  );

  server.registerTool(
    "monitor_status",
    { title: "Monitor status", description: "Indexer health: chain head, last indexed block, number of markets, whether it is live." },
    async () => json({ ...indexer.status, lag_blocks: indexer.status.head - indexer.status.indexedTo, native: NATIVE }),
  );

  return server;
}

function round(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
