// SQLite store (node:sqlite, built into Node 22): markets, trades, indexer cursor, Telegram subscriptions.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { MarketRow, TradeRow } from "./prosper.js";

export type Db = ReturnType<typeof openDb>;

export function openDb(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS markets (
      market TEXT PRIMARY KEY, pToken TEXT, vault TEXT, creator TEXT, symbol TEXT, name TEXT,
      decimals INTEGER, createdBlock INTEGER, createdTime INTEGER);
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY, market TEXT, symbol TEXT, side TEXT, trader TEXT, pros REAL, tokens REAL,
      fee REAL, price REAL, block INTEGER, time INTEGER, tx TEXT);
    CREATE INDEX IF NOT EXISTS trades_market_block ON trades (market, block);
    CREATE INDEX IF NOT EXISTS trades_block ON trades (block);
    CREATE TABLE IF NOT EXISTS subscriptions (
      chatId INTEGER, username TEXT, market TEXT, minPros REAL, PRIMARY KEY (chatId, market));
  `);

  const stmt = {
    getMeta: db.prepare("SELECT value FROM meta WHERE key = ?"),
    setMeta: db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
    upsertMarket: db.prepare(`INSERT OR REPLACE INTO markets VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    markets: db.prepare("SELECT * FROM markets ORDER BY createdBlock"),
    insertTrade: db.prepare(`INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    addSub: db.prepare("INSERT OR REPLACE INTO subscriptions VALUES (?, ?, ?, ?)"),
    delSub: db.prepare("DELETE FROM subscriptions WHERE chatId = ? AND market = ?"),
    delAllSubs: db.prepare("DELETE FROM subscriptions WHERE chatId = ?"),
    subsByChat: db.prepare("SELECT * FROM subscriptions WHERE chatId = ? ORDER BY market"),
    subsByMarket: db.prepare("SELECT * FROM subscriptions WHERE market = ? OR market = '*'"),
  };

  return {
    meta: (key: string) => (stmt.getMeta.get(key) as { value: string } | undefined)?.value,
    setMeta: (key: string, value: string) => stmt.setMeta.run(key, value),
    upsertMarket: (m: MarketRow) =>
      stmt.upsertMarket.run(m.market, m.pToken, m.vault, m.creator, m.symbol, m.name, m.decimals, m.createdBlock, m.createdTime),
    markets: () => stmt.markets.all() as unknown as MarketRow[],
    /** Returns true when the trade was new (not a duplicate). */
    insertTrade: (t: TradeRow) =>
      Number(stmt.insertTrade.run(t.id, t.market, t.symbol, t.side, t.trader, t.pros, t.tokens, t.fee, t.price, t.block, t.time, t.tx).changes) > 0,
    trades: (f: { market?: string; trader?: string; side?: string; minPros?: number; sinceTime?: number; afterBlock?: number; limit?: number }) => {
      const where: string[] = [];
      const args: (string | number)[] = [];
      if (f.market) { where.push("market = ?"); args.push(f.market); }
      if (f.trader) { where.push("lower(trader) = ?"); args.push(f.trader.toLowerCase()); }
      if (f.side) { where.push("side = ?"); args.push(f.side); }
      if (f.minPros) { where.push("pros >= ?"); args.push(f.minPros); }
      if (f.sinceTime) { where.push("time >= ?"); args.push(f.sinceTime); }
      if (f.afterBlock !== undefined) { where.push("block > ?"); args.push(f.afterBlock); }
      const sql = `SELECT * FROM trades ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY block DESC, id DESC LIMIT ?`;
      return db.prepare(sql).all(...args, Math.min(f.limit ?? 20, 200)) as unknown as TradeRow[];
    },
    stats: (market: string, sinceTime: number) =>
      db.prepare(`SELECT count(*) AS trades, coalesce(sum(CASE WHEN side='BUY' THEN 1 ELSE 0 END),0) AS buys,
        coalesce(sum(CASE WHEN side='SELL' THEN 1 ELSE 0 END),0) AS sells,
        coalesce(sum(CASE WHEN side='BUY' THEN pros ELSE 0 END),0) AS buyPros,
        coalesce(sum(CASE WHEN side='SELL' THEN pros ELSE 0 END),0) AS sellPros,
        count(DISTINCT trader) AS traders FROM trades WHERE market = ? AND time >= ?`).get(market, sinceTime) as Record<string, number>,
    lastTrade: (market: string) => db.prepare("SELECT * FROM trades WHERE market = ? ORDER BY block DESC LIMIT 1").get(market) as TradeRow | undefined,
    netCurvePros: (market: string) =>
      (db.prepare(`SELECT coalesce(sum(CASE WHEN side='BUY' THEN pros - fee ELSE -(pros + fee) END),0) AS v FROM trades WHERE market = ?`).get(market) as { v: number }).v,
    addSub: (chatId: number, username: string, market: string, minPros: number) => stmt.addSub.run(chatId, username, market, minPros),
    delSub: (chatId: number, market: string) => stmt.delSub.run(chatId, market),
    delAllSubs: (chatId: number) => stmt.delAllSubs.run(chatId),
    subsByChat: (chatId: number) => stmt.subsByChat.all(chatId) as unknown as { chatId: number; username: string; market: string; minPros: number }[],
    subsByMarket: (market: string) => stmt.subsByMarket.all(market) as unknown as { chatId: number; username: string; market: string; minPros: number }[],
  };
}
