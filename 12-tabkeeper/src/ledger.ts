// The ledger: an append-only journal of tasks, refusals and payments, and the totals derived from it. A payment
// is keyed by its EIP-3009 nonce, which the USDC contract accepts once: however many times a payment is retried
// or reported, it counts once. Money is held against the budget from the moment a payment is signed until it is
// either seen on chain (paid) or provably dead (its authorization expired unused: released).
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type Row =
  | { event: "task"; at: string; task: string; name: string; budget: string; cap: string }
  | { event: "task-end"; at: string; task: string; note?: string }
  | { event: "refused"; at: string; task: string; url: string; price: string; why: string }
  | { event: "signed"; at: string; task: string; url: string; item: string; price: string; from: string; to: string; nonce: string; validBefore: string; block: string; header: string }
  | { event: "attempt"; at: string; nonce: string; n: number; result: string }
  | { event: "paid"; at: string; task: string; nonce: string; tx: string; price: string; replayed?: boolean }
  | { event: "released"; at: string; task: string; nonce: string; why: string };

export interface Payment {
  task: string;
  url: string;
  item: string;
  /** Atomic USDC units (6 decimals). */
  price: bigint;
  from: string;
  to: string;
  nonce: string;
  validBefore: bigint;
  block: bigint;
  header: string;
  state: "open" | "paid" | "released";
  tx?: string;
  at: string;
}

export interface TaskState {
  id: string;
  name: string;
  budget: bigint;
  cap: bigint;
  ended: boolean;
  spent: bigint;
  /** Signed, not yet seen on chain, not yet expired: may still be paid. */
  held: bigint;
  payments: Payment[];
  refusals: { url: string; price: bigint; why: string; at: string }[];
}

export const usdc = (atomic: bigint) => {
  const s = atomic.toString().padStart(7, "0");
  const whole = s.slice(0, -6);
  const frac = s.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
};

export function parseUsdc(text: string): bigint {
  if (!/^\d+(\.\d{1,6})?$/.test(text)) throw new Error(`not a USDC amount: ${text}`);
  const [w, f = ""] = text.split(".");
  return BigInt(w) * 1_000_000n + BigInt(f.padEnd(6, "0"));
}

export function payments(rows: Row[]): Map<string, Payment> {
  const m = new Map<string, Payment>();
  for (const r of rows) {
    if (r.event === "signed") {
      if (m.has(r.nonce)) continue;
      m.set(r.nonce, { task: r.task, url: r.url, item: r.item, price: BigInt(r.price), from: r.from, to: r.to, nonce: r.nonce, validBefore: BigInt(r.validBefore), block: BigInt(r.block), header: r.header, state: "open", at: r.at });
    } else if (r.event === "paid") {
      const p = m.get(r.nonce);
      if (p && p.state !== "paid") Object.assign(p, { state: "paid", tx: r.tx }); // a second report of the same nonce changes nothing
    } else if (r.event === "released") {
      const p = m.get(r.nonce);
      if (p && p.state === "open") p.state = "released";
    }
  }
  return m;
}

export function tasks(rows: Row[]): Map<string, TaskState> {
  const t = new Map<string, TaskState>();
  for (const r of rows) {
    if (r.event === "task") t.set(r.task, { id: r.task, name: r.name, budget: BigInt(r.budget), cap: BigInt(r.cap), ended: false, spent: 0n, held: 0n, payments: [], refusals: [] });
    else if (r.event === "task-end") {
      const s = t.get(r.task);
      if (s) s.ended = true;
    } else if (r.event === "refused") t.get(r.task)?.refusals.push({ url: r.url, price: BigInt(r.price), why: r.why, at: r.at });
  }
  for (const p of payments(rows).values()) {
    const s = t.get(p.task);
    if (!s) continue;
    s.payments.push(p);
    if (p.state === "paid") s.spent += p.price;
    if (p.state === "open") s.held += p.price;
  }
  return t;
}

/** The task a buy goes to: the last one started and not ended. */
export function currentTask(rows: Row[]): TaskState | undefined {
  const open = [...tasks(rows).values()].filter((s) => !s.ended);
  return open[open.length - 1];
}

export type Decision = { ok: true } | { ok: false; why: string };

/** The two limits, checked before anything is signed. */
export function allow(t: Pick<TaskState, "budget" | "cap" | "spent" | "held">, price: bigint, maxPrice?: bigint): Decision {
  if (price <= 0n) return { ok: false, why: "the seller asks for no money but still wants a payment" };
  if (price > t.cap) return { ok: false, why: `price ${usdc(price)} USDC is over the per-call cap of ${usdc(t.cap)} USDC` };
  if (maxPrice !== undefined && price > maxPrice) return { ok: false, why: `price ${usdc(price)} USDC is over the ${usdc(maxPrice)} USDC this data is worth to the task` };
  const left = t.budget - t.spent - t.held;
  if (price > left)
    return { ok: false, why: `budget: ${usdc(t.spent)} of ${usdc(t.budget)} USDC spent${t.held ? ` and ${usdc(t.held)} held by a payment in flight` : ""}, ${usdc(left > 0n ? left : 0n)} left, this call costs ${usdc(price)}` };
  return { ok: true };
}

export function journalFile(home: string) {
  return join(home, "journal.jsonl");
}

export function readRows(home: string): Row[] {
  const f = journalFile(home);
  return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Row) : [];
}

export function append(home: string, row: Row): void {
  mkdirSync(home, { recursive: true });
  appendFileSync(journalFile(home), `${JSON.stringify(row)}\n`);
}
