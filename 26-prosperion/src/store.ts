// Everything Prosperion remembers, in one SQLite file: launches the watcher saw, who watches what and where to ping
// them, what the agent concluded (so you can read its reasoning later), signing requests behind push links, and
// counters for the open chat. No keys, no passwords: a wallet signature is the only login.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { getAddress, type Address } from "viem";
import type { MarketCheck } from "./market.js";

export interface Launch {
  market: Address;
  vault: Address;
  pToken: Address;
  block: bigint;
  tx: string;
  checks: MarketCheck | null;
}
export interface Watch {
  address: Address;
  maxPerBuyWei: bigint;
  /** Alert only while at most this much PROS is already in the curve (0 = only untouched launches). */
  maxReserveBeforeWei: bigint;
  curatorDeny: string[];
  telegramChatId?: number;
  discordWebhook?: string;
}
export interface Decision {
  at: number;
  kind: "verdict" | "proposal" | "refusal";
  subject: string;
  reason: string;
  block: bigint | null;
}
export type RequestKind = "buy" | "setLimits" | "deposit" | "redeem";
export interface TxRequest {
  id: string;
  kind: RequestKind;
  params: Record<string, string | number>;
  createdBlock: bigint;
}

const LINK_TTL_MS = 10 * 60_000;
const json = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v));

export function openStore(path: string) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS launches (market TEXT PRIMARY KEY, vault TEXT, ptoken TEXT, block INTEGER, tx TEXT, checks TEXT);
    CREATE TABLE IF NOT EXISTS watches (address TEXT PRIMARY KEY, max_per_buy TEXT, max_reserve TEXT, curator_deny TEXT,
      tg_chat INTEGER, discord TEXT);
    CREATE TABLE IF NOT EXISTS link_codes (code TEXT PRIMARY KEY, address TEXT, created INTEGER, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS decisions (at INTEGER, kind TEXT, subject TEXT, reason TEXT, block TEXT);
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, kind TEXT, params TEXT, created_block TEXT, created INTEGER);
    CREATE TABLE IF NOT EXISTS turns (ip TEXT, day TEXT, n INTEGER, PRIMARY KEY (ip, day));
    CREATE TABLE IF NOT EXISTS nonces (nonce TEXT PRIMARY KEY, created INTEGER, used INTEGER DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, address TEXT, expires INTEGER);
  `);

  const rowToWatch = (r: Record<string, unknown>): Watch => ({
    address: r.address as Address,
    maxPerBuyWei: BigInt(r.max_per_buy as string),
    maxReserveBeforeWei: BigInt(r.max_reserve as string),
    curatorDeny: JSON.parse(r.curator_deny as string),
    telegramChatId: (r.tg_chat as number | null) ?? undefined,
    discordWebhook: (r.discord as string | null) ?? undefined,
  });

  return {
    db,

    saveLaunch(l: Launch) {
      db.prepare("INSERT OR REPLACE INTO launches VALUES (?, ?, ?, ?, ?, ?)")
        .run(getAddress(l.market), l.vault, l.pToken, Number(l.block), l.tx, l.checks ? json(l.checks) : null);
    },
    listLaunches(limit: number): Launch[] {
      return (db.prepare("SELECT * FROM launches ORDER BY block DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
        market: r.market as Address, vault: r.vault as Address, pToken: r.ptoken as Address,
        block: BigInt(r.block as number), tx: r.tx as string, checks: r.checks ? JSON.parse(r.checks as string) : null,
      }));
    },

    upsertWatch(w: Watch) {
      const address = getAddress(w.address);
      const old = db.prepare("SELECT tg_chat, discord FROM watches WHERE address = ?").get(address) as Record<string, unknown> | undefined;
      db.prepare("INSERT OR REPLACE INTO watches VALUES (?, ?, ?, ?, ?, ?)").run(
        address, w.maxPerBuyWei.toString(), w.maxReserveBeforeWei.toString(), JSON.stringify(w.curatorDeny),
        w.telegramChatId ?? (old?.tg_chat as number | null) ?? null, w.discordWebhook ?? (old?.discord as string | null) ?? null,
      );
    },
    watchesFor(address: string): Watch[] {
      return (db.prepare("SELECT * FROM watches WHERE address = ?").all(getAddress(address)) as Record<string, unknown>[]).map(rowToWatch);
    },
    allWatches(): Watch[] {
      return (db.prepare("SELECT * FROM watches").all() as Record<string, unknown>[]).map(rowToWatch);
    },
    setDiscord(address: string, webhook: string | null) {
      db.prepare("UPDATE watches SET discord = ? WHERE address = ?").run(webhook, getAddress(address));
    },

    newLinkCode(address: string, now = Date.now()): string {
      const code = randomBytes(6).toString("hex");
      db.prepare("INSERT INTO link_codes (code, address, created) VALUES (?, ?, ?)").run(code, getAddress(address), now);
      return code;
    },
    /** Binds a Telegram chat to the address that asked for the code. One use, ten minutes. */
    linkTelegram(code: string, chatId: number): Address | null {
      const r = db.prepare("SELECT address, created, used FROM link_codes WHERE code = ?").get(code) as Record<string, unknown> | undefined;
      if (!r || r.used || Date.now() - (r.created as number) > LINK_TTL_MS) return null;
      db.prepare("UPDATE link_codes SET used = 1 WHERE code = ?").run(code);
      db.prepare("UPDATE watches SET tg_chat = ? WHERE address = ?").run(chatId, r.address as string);
      return r.address as Address;
    },

    logDecision(d: Decision) {
      db.prepare("INSERT INTO decisions VALUES (?, ?, ?, ?, ?)").run(d.at, d.kind, d.subject, d.reason, d.block?.toString() ?? null);
    },
    decisions(limit: number): Decision[] {
      return (db.prepare("SELECT * FROM decisions ORDER BY at DESC LIMIT ?").all(limit) as Record<string, unknown>[]).map((r) => ({
        at: r.at as number, kind: r.kind as Decision["kind"], subject: r.subject as string, reason: r.reason as string,
        block: r.block ? BigInt(r.block as string) : null,
      }));
    },

    saveRequest(r: Omit<TxRequest, "id">): string {
      const id = randomBytes(9).toString("base64url");
      db.prepare("INSERT INTO requests VALUES (?, ?, ?, ?, ?)").run(id, r.kind, JSON.stringify(r.params), r.createdBlock.toString(), Date.now());
      return id;
    },
    getRequest(id: string): TxRequest | null {
      const r = db.prepare("SELECT * FROM requests WHERE id = ?").get(id) as Record<string, unknown> | undefined;
      return r ? { id, kind: r.kind as RequestKind, params: JSON.parse(r.params as string), createdBlock: BigInt(r.created_block as string) } : null;
    },

    addTurn(ip: string, day: string) {
      db.prepare("INSERT INTO turns VALUES (?, ?, 1) ON CONFLICT(ip, day) DO UPDATE SET n = n + 1").run(ip, day);
    },
    countTurns(ip: string, day: string): number {
      return ((db.prepare("SELECT n FROM turns WHERE ip = ? AND day = ?").get(ip, day) as { n: number } | undefined)?.n) ?? 0;
    },
    totalTurns(day: string): number {
      return ((db.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM turns WHERE day = ?").get(day) as { n: number }).n);
    },

    // used by auth.ts
    putNonce(nonce: string, now = Date.now()) {
      db.prepare("INSERT INTO nonces (nonce, created) VALUES (?, ?)").run(nonce, now);
    },
    takeNonce(nonce: string, maxAgeMs: number): boolean {
      const r = db.prepare("SELECT created, used FROM nonces WHERE nonce = ?").get(nonce) as Record<string, number> | undefined;
      if (!r || r.used || Date.now() - r.created > maxAgeMs) return false;
      db.prepare("UPDATE nonces SET used = 1 WHERE nonce = ?").run(nonce);
      return true;
    },
    newSession(address: Address, ttlMs: number): string {
      const token = randomBytes(24).toString("base64url");
      db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run(token, getAddress(address), Date.now() + ttlMs);
      return token;
    },
    sessionAddress(token: string): Address | null {
      const r = db.prepare("SELECT address, expires FROM sessions WHERE token = ?").get(token) as Record<string, unknown> | undefined;
      return r && (r.expires as number) > Date.now() ? (r.address as Address) : null;
    },
  };
}
export type Store = ReturnType<typeof openStore>;
