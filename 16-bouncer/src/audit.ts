// The audit log: one JSON line per decision, send and receipt, in audit.jsonl next to the policy. Lines are
// chained: each carries the hash of the line before it and its own hash, so an edited, removed or reordered line
// shows up in `bouncer log --verify`. That's tamper-evident, not tamper-proof: someone can rewrite the whole file,
// but not quietly change one decision. The daily spend rule reads its numbers from here and nowhere else.
import { appendFileSync, closeSync, existsSync, openSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { keccak256, toBytes, type Hex } from "viem";
import type { Policy } from "./policy.js";

export type Entry = { at: string; kind: "decision" | "sent" | "receipt" | "error"; prev: Hex; hash: Hex; [k: string]: unknown };
export type EntryBody = { kind: Entry["kind"]; [k: string]: unknown };

const GENESIS = `0x${"0".repeat(64)}` as Hex;
const sealOf = (unsealed: Omit<Entry, "hash">): Hex => keccak256(toBytes(JSON.stringify(unsealed)));
const nap = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A lock file next to the log: exclusive create, retried every 100 ms. A bouncer that died mid-work leaves its lock
 * behind, so a lock older than `staleMs` is taken over. The log uses a short one per line; send holds a longer one
 * from its fresh check until its "sent" line is written, so two sends can't both read the same daily total.
 */
export async function holdLock<T>(home: string, name: string, work: () => T | Promise<T>, o: { waitMs: number; staleMs: number }): Promise<T> {
  const lock = join(home, name);
  for (let waited = 0; ; waited += 100) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > o.staleMs) rmSync(lock, { force: true });
      else if (waited >= o.waitMs) throw new Error(`${lock} has been held for ${o.waitMs / 1000} s; is another bouncer stuck?`);
      else await nap(100);
    }
  }
  try {
    return await work();
  } finally {
    rmSync(lock, { force: true });
  }
}

export function readLog(home: string): { entries: Entry[]; brokenAt: number | null } {
  const file = join(home, "audit.jsonl");
  if (!existsSync(file)) return { entries: [], brokenAt: null };
  const entries: Entry[] = [];
  let prev = GENESIS;
  const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() !== "");
  for (const [i, line] of lines.entries()) {
    let e: Entry;
    try {
      e = JSON.parse(line) as Entry;
    } catch {
      return { entries, brokenAt: i + 1 };
    }
    const { hash, ...unsealed } = e;
    if (e.prev !== prev || hash !== sealOf(unsealed)) return { entries, brokenAt: i + 1 };
    entries.push(e);
    prev = hash;
  }
  return { entries, brokenAt: null };
}

export async function appendEntry(home: string, body: EntryBody, now: Date): Promise<Entry> {
  return holdLock(home, "audit.lock", () => {
    const { entries, brokenAt } = readLog(home);
    // Even a broken log gets the new line: chained to the last good one, so --verify still points at the damage.
    const last = brokenAt === null ? entries.at(-1) : entries[brokenAt - 2];
    const unsealed = { at: now.toISOString(), ...body, prev: last?.hash ?? GENESIS } as Omit<Entry, "hash">;
    const entry = { ...unsealed, hash: sealOf(unsealed) } as Entry;
    appendFileSync(join(home, "audit.jsonl"), JSON.stringify(entry) + "\n");
    return entry;
  }, { waitMs: 5000, staleMs: 30_000 });
}

/**
 * What left the wallet since `since`, per spend key, as the log tells it: a send counts its receipt's amounts when
 * the receipt says success, nothing when it reverted, and its traced amounts while no receipt is known yet (a
 * crash between send and receipt must not open room for more spending).
 */
export function spentSince(entries: Entry[], since: Date, policy: Policy): Map<string, bigint> {
  const receipts = new Map<string, Entry>();
  for (const e of entries) if (e.kind === "receipt") receipts.set(String(e.txHash), e);
  const spent = new Map<string, bigint>();
  for (const e of entries) {
    if (e.kind !== "sent" || new Date(e.at) < since) continue;
    const receipt = receipts.get(String(e.txHash));
    const amounts = receipt ? (receipt.status === "success" ? receipt.amounts : {}) : e.amounts;
    for (const [key, raw] of Object.entries((amounts ?? {}) as Record<string, string>))
      if (policy.spend[key]) spent.set(key, (spent.get(key) ?? 0n) + BigInt(raw));
  }
  return spent;
}
