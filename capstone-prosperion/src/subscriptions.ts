// What each person asked the Prosperion bot to tell them. One row per wallet and kind, so the Alerts page is a set
// of switches with a few numbers each, not a rule builder. The bot is shared: whoever runs the copy owns the token,
// people only link their chat to their wallet (a signed-in code on the site, then /start in Telegram).
//
// Next to the switches live the things that keep it honest: a delivery ledger so one event reaches one wallet once
// (two sources can see the same trade, the server can restart mid-send), mutes and follows per market, a pause, and
// small bits of state the pollers compare against (last board, last position values, log cursors).
import type { DatabaseSync } from "node:sqlite";
import { getAddress, isAddress, type Address } from "viem";

export const KINDS = ["launch", "snipe", "progress", "positions", "whales", "security", "digest"] as const;
export type Kind = (typeof KINDS)[number];
export type Scope = "all" | "mine";
export const THRESHOLDS = [25, 50, 75, 90] as const;

export interface Subs {
  /** a new Prosper market that passed the checks: facts, then the agent's notes */
  launch: { on: boolean; maxInCurvePros: string | null; skipCurators: string[] };
  /** same moment, but with a buy for your address already prepared: open, connect, sign */
  snipe: { on: boolean; amountPros: string; maxInCurvePros: string };
  /** a curve crossing a share of its 20,000 PROS target, graduating or failing */
  progress: { on: boolean; thresholds: number[]; phase: boolean; scope: Scope };
  /** what you hold: a pToken's sell value or a vault share's price moving by this much since the last alert */
  positions: { on: boolean; movePct: number; navMovePct: number };
  /** a buy or sell of at least this much PROS on a curve */
  whales: { on: boolean; minPros: string; scope: Scope };
  /** the gate saw your wallet: limits changed, a buy went through */
  security: { on: boolean };
  /** once a day at this UTC hour: positions, the closest launches, what moved */
  digest: { on: boolean; hourUtc: number };
}

export const DEFAULT_SUBS: Subs = {
  launch: { on: false, maxInCurvePros: "0", skipCurators: [] },
  snipe: { on: false, amountPros: "0.1", maxInCurvePros: "0" },
  progress: { on: false, thresholds: [50, 90], phase: true, scope: "mine" },
  positions: { on: false, movePct: 10, navMovePct: 1 },
  whales: { on: false, minPros: "500", scope: "mine" },
  security: { on: false },
  digest: { on: false, hourUtc: 9 },
};

const prosText = /^\d+(\.\d{1,18})?$/;
const between = (x: unknown, lo: number, hi: number) => typeof x === "number" && Number.isFinite(x) && x >= lo && x <= hi;
const prosBetween = (x: unknown, lo: number, hi: number) => typeof x === "string" && prosText.test(x) && Number(x) >= lo && Number(x) <= hi;
const scopeOk = (x: unknown): x is Scope => x === "all" || x === "mine";

/** The Alerts form, kind by kind, or the first thing wrong with it. Kinds left out keep their defaults, off. */
export function parseSubs(input: unknown): Subs | { error: string } {
  const b = (input && typeof input === "object" ? input : {}) as Record<string, Record<string, unknown> | undefined>;
  const out: Subs = structuredClone(DEFAULT_SUBS);
  const on = (k: Kind) => b[k]?.on === true;

  if (b.launch) {
    const x = b.launch;
    const max = x.maxInCurvePros === null || x.maxInCurvePros === "" ? null : x.maxInCurvePros;
    if (max !== null && !prosBetween(max, 0, 20_000)) return { error: "launch: PROS already in the curve must be a number up to 20000, or empty for any" };
    const skip = Array.isArray(x.skipCurators) ? x.skipCurators : [];
    if (!skip.every((a) => typeof a === "string" && isAddress(a))) return { error: "launch: every curator to skip must be an address" };
    out.launch = { on: on("launch"), maxInCurvePros: max as string | null, skipCurators: (skip as string[]).map((a) => a.toLowerCase()) };
  }
  if (b.snipe) {
    const x = b.snipe;
    if (!prosBetween(x.amountPros, 0.000001, 1000)) return { error: "snipe: the amount must be between 0.000001 and 1000 PROS" };
    if (!prosBetween(x.maxInCurvePros, 0, 20_000)) return { error: "snipe: PROS already in the curve must be a number up to 20000" };
    out.snipe = { on: on("snipe"), amountPros: x.amountPros as string, maxInCurvePros: x.maxInCurvePros as string };
  }
  if (b.progress) {
    const x = b.progress;
    const t = Array.isArray(x.thresholds) ? x.thresholds : [];
    if (!t.every((n) => (THRESHOLDS as readonly unknown[]).includes(n))) return { error: `progress: thresholds can only be ${THRESHOLDS.join(", ")}` };
    if (!scopeOk(x.scope)) return { error: "progress: scope is all or mine" };
    out.progress = { on: on("progress"), thresholds: [...new Set(t as number[])].sort((a, z) => a - z), phase: x.phase !== false, scope: x.scope };
  }
  if (b.positions) {
    const x = b.positions;
    if (!between(x.movePct, 1, 90)) return { error: "positions: the move must be between 1 and 90 percent" };
    if (!between(x.navMovePct, 0.1, 50)) return { error: "positions: the vault price move must be between 0.1 and 50 percent" };
    out.positions = { on: on("positions"), movePct: x.movePct as number, navMovePct: x.navMovePct as number };
  }
  if (b.whales) {
    const x = b.whales;
    if (!prosBetween(x.minPros, 1, 1_000_000)) return { error: "whales: the size must be a number of PROS, at least 1" };
    if (!scopeOk(x.scope)) return { error: "whales: scope is all or mine" };
    out.whales = { on: on("whales"), minPros: x.minPros as string, scope: x.scope };
  }
  if (b.security) out.security = { on: on("security") };
  if (b.digest) {
    if (!Number.isInteger(b.digest.hourUtc) || !between(b.digest.hourUtc, 0, 23)) return { error: "digest: the hour is 0 to 23, UTC" };
    out.digest = { on: on("digest"), hourUtc: b.digest.hourUtc as number };
  }
  return out;
}

export interface Recipient<K extends Kind = Kind> {
  address: Address;
  chatId: number;
  params: Subs[K];
}

export function openAlertBook(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS subs (address TEXT, kind TEXT, params TEXT, PRIMARY KEY (address, kind));
    CREATE TABLE IF NOT EXISTS deliveries (address TEXT, key TEXT, at INTEGER, PRIMARY KEY (address, key));
    CREATE TABLE IF NOT EXISTS follows (address TEXT, market TEXT, PRIMARY KEY (address, market));
    CREATE TABLE IF NOT EXISTS mutes (address TEXT, market TEXT, until INTEGER, PRIMARY KEY (address, market));
    CREATE TABLE IF NOT EXISTS alert_pause (address TEXT PRIMARY KEY, until INTEGER);
    CREATE TABLE IF NOT EXISTS notify_state (key TEXT PRIMARY KEY, value TEXT);
  `);
  const low = (a: string) => a.toLowerCase();

  return {
    saveSubs(address: string, s: Subs) {
      const a = getAddress(address);
      const put = db.prepare("INSERT OR REPLACE INTO subs VALUES (?, ?, ?)");
      for (const k of KINDS) put.run(a, k, JSON.stringify(s[k]));
    },
    subsOf(address: string): Subs {
      const out: Subs = structuredClone(DEFAULT_SUBS);
      const rows = db.prepare("SELECT kind, params FROM subs WHERE address = ?").all(getAddress(address)) as { kind: Kind; params: string }[];
      for (const r of rows) if ((KINDS as readonly string[]).includes(r.kind)) (out as unknown as Record<string, unknown>)[r.kind] = JSON.parse(r.params);
      return out;
    },
    /** Who gets this kind right now: switched on, linked to a chat, not paused. */
    recipients<K extends Kind>(kind: K, now = Date.now()): Recipient<K>[] {
      const rows = db.prepare(`
        SELECT s.address, s.params, w.tg_chat FROM subs s JOIN watches w ON w.address = s.address
        LEFT JOIN alert_pause p ON p.address = s.address
        WHERE s.kind = ? AND w.tg_chat IS NOT NULL AND (p.until IS NULL OR p.until <= ?)`).all(kind, now) as Record<string, unknown>[];
      return rows
        .map((r) => ({ address: r.address as Address, chatId: r.tg_chat as number, params: JSON.parse(r.params as string) as Subs[K] }))
        .filter((r) => (r.params as { on: boolean }).on);
    },
    addressesOfChat(chatId: number): Address[] {
      return (db.prepare("SELECT address FROM watches WHERE tg_chat = ?").all(chatId) as { address: Address }[]).map((r) => r.address);
    },
    unlinkAddress(address: string) {
      db.prepare("UPDATE watches SET tg_chat = NULL WHERE address = ?").run(getAddress(address));
    },
    unlinkChat(chatId: number): number {
      return Number(db.prepare("UPDATE watches SET tg_chat = NULL WHERE tg_chat = ?").run(chatId).changes);
    },

    pause(address: string, until: number) {
      db.prepare("INSERT OR REPLACE INTO alert_pause VALUES (?, ?)").run(getAddress(address), until);
    },
    pausedUntil(address: string, now = Date.now()): number | null {
      const r = db.prepare("SELECT until FROM alert_pause WHERE address = ?").get(getAddress(address)) as { until: number } | undefined;
      return r && r.until > now ? r.until : null;
    },

    follow(address: string, market: string) {
      db.prepare("INSERT OR IGNORE INTO follows VALUES (?, ?)").run(getAddress(address), getAddress(market));
    },
    unfollow(address: string, market: string) {
      db.prepare("DELETE FROM follows WHERE address = ? AND market = ?").run(getAddress(address), getAddress(market));
    },
    follows(address: string): Address[] {
      return (db.prepare("SELECT market FROM follows WHERE address = ?").all(getAddress(address)) as { market: Address }[]).map((r) => r.market);
    },
    mute(address: string, market: string, until: number) {
      db.prepare("INSERT OR REPLACE INTO mutes VALUES (?, ?, ?)").run(getAddress(address), low(market), until);
    },
    isMuted(address: string, market: string, now = Date.now()): boolean {
      const r = db.prepare("SELECT until FROM mutes WHERE address = ? AND market = ?").get(getAddress(address), low(market)) as { until: number } | undefined;
      return !!r && r.until > now;
    },

    /** True the first time this wallet is due this event; false ever after. Claimed before sending. */
    claim(address: string, key: string, now = Date.now()): boolean {
      return Number(db.prepare("INSERT OR IGNORE INTO deliveries VALUES (?, ?, ?)").run(getAddress(address), key, now).changes) === 1;
    },

    getState<T = unknown>(key: string): T | null {
      const r = db.prepare("SELECT value FROM notify_state WHERE key = ?").get(key) as { value: string } | undefined;
      return r ? (JSON.parse(r.value) as T) : null;
    },
    setState(key: string, value: unknown) {
      db.prepare("INSERT OR REPLACE INTO notify_state VALUES (?, ?)")
        .run(key, JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
    },
  };
}
export type AlertBook = ReturnType<typeof openAlertBook>;
