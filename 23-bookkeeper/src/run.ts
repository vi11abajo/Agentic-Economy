// One wake of the bookkeeper. The OS scheduler starts it; it looks at every approved series, pays what is due,
// finishes what an earlier run left half done, tells the user, and exits. Nothing stays running.
//
// The rules that keep money safe:
//   - a payment is written to the journal as "signed" (with its raw bytes) BEFORE it is broadcast;
//   - an attempt the chain may still mine is never replaced by a new one (USDC: the token would refuse the second
//     anyway, its nonce is per period and payee; PROS: we re-send the same bytes or wait until the account nonce
//     proves the old one can never land);
//   - a period whose window has closed is "missed" and never paid late without a new yes from the user.
import { formatUnits, parseUnits, type PrivateKeyAccount } from "viem";
import { RUNWAY_CAP, type Card, type Notifier, type RunwayLine } from "./cards.js";
import { USDC, type Chain } from "./chain.js";
import { acquireLock, releaseLock } from "./lock.js";
import { buildProsPayment, buildUsdcPayment, paymentNonce, usdcCall } from "./pay.js";
import { dueAt, indexAt } from "./period.js";
import { DECIMALS } from "./plan.js";
import { appendJournal, loadSeries, readJournal, type Hex, type JournalEvent, type Series } from "./store.js";

// What one payment costs in gas, for the runway forecast (a USDC transferWithAuthorization is ~75-100k on Pharos).
export const GAS_PER_PAYMENT = 100_000n;
const RECEIPT_POLLS = 15;
const RECEIPT_POLL_MS = 2_000;

export type Status = "due" | "short" | "sent" | "paid" | "failed" | "missed";
export interface PaymentState {
  series: string;
  period: number;
  payee: number;
  name: string;
  amount: string;
  due: string;
  status: Status;
  tx?: Hex;
  note?: string;
}

export interface RunReport {
  skipped?: "locked";
  paid: number;
  short: number;
  failed: number;
  missed: number;
  undelivered: number;
  lines: string[];
  runway: RunwayLine[];
  nextDue: string | null;
}

export interface RunCtx {
  home: string;
  chain: Chain;
  account: PrivateKeyAccount;
  now: Date;
  notify: Notifier;
  sleep?: (ms: number) => Promise<void>;
}

const forKey = (j: JournalEvent[], s: string, p: number, i: number) => j.filter((e) => e.series === s && e.period === p && e.payee === i);

/** The open attempt: the last signed tx that has no paid/failed answer yet. */
function openAttempt(events: JournalEvent[]): JournalEvent | null {
  const signed = events.filter((e) => e.kind === "signed");
  const last = signed[signed.length - 1];
  if (!last) return null;
  const answered = events.some((e) => (e.kind === "paid" || e.kind === "failed") && e.tx === last.tx);
  return answered ? null : last;
}

export function paymentStates(s: Series, journal: JournalEvent[], now: Date): PaymentState[] {
  const out: PaymentState[] = [];
  const last = indexAt(s.first, s.tz, s.every, now);
  for (let p = 0; p <= last; p++) {
    const closed = now.getTime() >= dueAt(s.first, s.tz, s.every, p + 1).getTime();
    s.payees.forEach((payee, i) => {
      const ev = forKey(journal, s.id, p, i);
      const paid = ev.find((e) => e.kind === "paid");
      const base = { series: s.id, period: p, payee: i, name: payee.name, amount: payee.amount, due: dueAt(s.first, s.tz, s.every, p).toISOString() };
      if (paid) return out.push({ ...base, status: "paid", tx: paid.tx as Hex | undefined });
      if (ev.some((e) => e.kind === "missed")) return out.push({ ...base, status: "missed" });
      const open = openAttempt(ev);
      if (open) return out.push({ ...base, status: "sent", tx: open.tx as Hex });
      const stuck = ev.find((e) => e.kind === "failed" && e.stuck);
      if (stuck) return out.push({ ...base, status: "failed", tx: stuck.tx as Hex | undefined, note: "needs you: " + String(stuck.reason) });
      if (s.status !== "active" && !ev.length) return;
      if (closed) return out.push({ ...base, status: "missed", note: "window closed" });
      const lastNews = [...ev].reverse().find((e) => e.kind === "failed" || e.kind === "short");
      if (lastNews?.kind === "failed") return out.push({ ...base, status: "failed", tx: lastNews.tx as Hex | undefined, note: String(lastNews.reason ?? "") });
      if (lastNews?.kind === "short") return out.push({ ...base, status: "short", note: `needs ${lastNews.need}, had ${lastNews.have} ${lastNews.asset}` });
      out.push({ ...base, status: "due" });
    });
  }
  return out;
}

const perPeriod = (s: Series) => s.payees.reduce((t, p) => t + parseUnits(p.amount, DECIMALS[s.token]), 0n);

/** How many coming periods of each series the wallet covers, spending in date order across all series. */
export function runway(series: Series[], bal: { usdc: bigint; pros: bigint }, now: Date, gasPerPayment: bigint): RunwayLine[] {
  const active = series.filter((s) => s.status === "active");
  const queue: { s: Series; due: Date }[] = [];
  for (const s of active) {
    const next = indexAt(s.first, s.tz, s.every, now) + 1;
    for (let k = 0; k <= RUNWAY_CAP; k++) queue.push({ s, due: dueAt(s.first, s.tz, s.every, next + k) });
  }
  queue.sort((a, b) => a.due.getTime() - b.due.getTime());
  let usdc = bal.usdc, pros = bal.pros, broke = false;
  const covered = new Map<string, { n: number; until: Date | null }>();
  for (const s of active) covered.set(s.id, { n: 0, until: null });
  for (const { s, due } of queue) {
    if (broke) break;
    const need = perPeriod(s), gas = gasPerPayment * BigInt(s.payees.length);
    const ok = s.token === "USDC" ? usdc >= need && pros >= gas : pros >= need + gas;
    if (!ok) {
      broke = true;
      break;
    }
    if (s.token === "USDC") usdc -= need;
    else pros -= need;
    pros -= gas;
    const c = covered.get(s.id)!;
    if (c.n < RUNWAY_CAP) covered.set(s.id, { n: c.n + 1, until: due });
  }
  return active.map((s) => {
    const c = covered.get(s.id)!;
    const next = dueAt(s.first, s.tz, s.every, indexAt(s.first, s.tz, s.every, now) + 1);
    return { series: s.id, label: s.label, token: s.token, tz: s.tz, perPeriod: formatUnits(perPeriod(s), DECIMALS[s.token]), nextDue: next.toISOString(), coversPeriods: c.n, until: c.until?.toISOString() ?? null, nextShort: c.n === 0 };
  });
}

export async function runOnce(ctx: RunCtx): Promise<RunReport> {
  const report: RunReport = { paid: 0, short: 0, failed: 0, missed: 0, undelivered: 0, lines: [], runway: [], nextDue: null };
  if (!acquireLock(ctx.home)) return { ...report, skipped: "locked" };
  try {
    await payWhatIsDue(ctx, report);
    await tellTheUser(ctx, report);
    const series = loadSeries(ctx.home).filter((s) => s.status === "active");
    const next = series.map((s) => dueAt(s.first, s.tz, s.every, indexAt(s.first, s.tz, s.every, ctx.now) + 1).getTime());
    report.nextDue = next.length ? new Date(Math.min(...next)).toISOString() : null;
    return report;
  } finally {
    releaseLock(ctx.home);
  }
}

async function payWhatIsDue(ctx: RunCtx, report: RunReport) {
  const { home, chain, account, now } = ctx;
  const sleep = ctx.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const wallet = account.address as Hex;
  const at = () => now.toISOString();
  const nowSec = BigInt(Math.floor(now.getTime() / 1000));
  let usdcLeft = await chain.usdcBalance(wallet);
  let prosLeft = await chain.prosBalance(wallet);
  const gasPrice = await chain.gasPrice();
  // Read once; every write below goes to the file and to this copy.
  const journal = readJournal(home);

  for (const s of loadSeries(home)) {
    const last = indexAt(s.first, s.tz, s.every, now);
    for (let p = 0; p <= last; p++) {
      const due = dueAt(s.first, s.tz, s.every, p);
      const nextDue = dueAt(s.first, s.tz, s.every, p + 1);
      for (let i = 0; i < s.payees.length; i++) {
        const payee = s.payees[i];
        const tag = `${s.label} #${p + 1} ${payee.name} ${payee.amount} ${s.token}`;
        const ev = forKey(journal, s.id, p, i);
        if (ev.some((e) => e.kind === "paid" || e.kind === "missed")) continue;
        const write = (kind: JournalEvent["kind"], extra: Record<string, unknown> = {}) => {
          const e: JournalEvent = { at: at(), series: s.id, period: p, payee: i, kind, ...extra };
          appendJournal(home, e);
          journal.push(e);
          ev.push(e);
        };
        const value = parseUnits(payee.amount, DECIMALS[s.token]);
        const authNonce = paymentNonce(wallet, s.id, s.planId, p, i);

        try {
        const paidNow = (tx: Hex | null, rc?: { blockNumber: bigint; gasUsed: bigint }, note?: string) => {
          write("paid", { tx, block: rc ? Number(rc.blockNumber) : undefined, gasUsed: rc ? Number(rc.gasUsed) : undefined, note });
          report.paid++;
          report.lines.push(`${tag}: paid${tx ? ` ${tx}` : ""}${note ? ` (${note})` : ""}`);
        };

        const waitFor = async (hash: Hex): Promise<"paid" | "failed" | "pending"> => {
          for (let k = 0; k < RECEIPT_POLLS; k++) {
            const rc = await chain.receipt(hash);
            if (rc?.status === "success") {
              paidNow(hash, rc);
              return "paid";
            }
            if (rc?.status === "reverted") {
              write("failed", { tx: hash, reason: "the transaction reverted on chain", block: Number(rc.blockNumber) });
              report.failed++;
              report.lines.push(`${tag}: reverted on chain ${hash}`);
              return "failed";
            }
            await sleep(RECEIPT_POLL_MS);
          }
          report.lines.push(`${tag}: sent ${hash}, not mined yet; the next run checks it`);
          return "pending";
        };

        // 1. Finish what an earlier run started.
        const open = openAttempt(ev);
        if (open) {
          const hash = open.tx as Hex;
          const rc = await chain.receipt(hash);
          if (rc?.status === "success") {
            paidNow(hash, rc);
            continue;
          }
          if (rc?.status === "reverted") {
            write("failed", { tx: hash, reason: "the transaction reverted on chain", block: Number(rc.blockNumber) });
            report.failed++;
            report.lines.push(`${tag}: reverted on chain ${hash}`);
            continue; // the next wake tries again
          } else if (await chain.knowsTx(hash)) {
            report.lines.push(`${tag}: still waiting for ${hash} to be mined`);
            continue;
          } else if (s.token === "USDC" && (await chain.authorizationState(wallet, authNonce))) {
            paidNow((await chain.findAuthorizationUsed(wallet, authNonce, BigInt(Number(open.block ?? 0)))) ?? hash, undefined, "found on chain");
            continue;
          } else if ((await chain.latestNonce(wallet)) > Number(open.txNonce)) {
            // A mined tx already used our account nonce, and it isn't ours (ours would have a receipt): these bytes can
            // never land. Ask once more after a pause, in case the receipt was just slow to show up.
            await sleep(RECEIPT_POLL_MS);
            const late = await chain.receipt(hash);
            if (late) {
              if (late.status === "success") paidNow(hash, late);
              else write("failed", { tx: hash, reason: "the transaction reverted on chain", block: Number(late.blockNumber) });
              continue;
            }
            if (s.token === "USDC") {
              // Safe to try again: the USDC nonce still guards this period.
              write("failed", { tx: hash, reason: "dropped: its account nonce was used by another transaction" });
              report.failed++;
            } else {
              // PROS has no such guard. Something else spent this nonce from the bookkeeper's wallet, so we stop and let
              // the user look rather than guess.
              write("failed", { tx: hash, stuck: true, reason: "the wallet's nonce for this payment was used by another transaction, so I can't be sure it wasn't paid; check it yourself, I won't retry it on my own" });
              report.failed++;
              report.lines.push(`${tag}: stuck, needs the user (nonce ${open.txNonce} used by another tx)`);
            }
            continue;
          } else {
            try {
              await chain.sendRaw(open.raw as Hex);
            } catch {
              // a duplicate/known answer is fine; whatever it was, the receipt below tells
            }
            write("sent", { tx: hash, note: "re-sent the same signed bytes" });
            await waitFor(hash);
            continue;
          }
        }

        if (ev.some((e) => e.kind === "failed" && e.stuck)) continue;
        // A stopped series only finishes what it had already sent; it doesn't collect missed periods either.
        if (s.status !== "active") continue;

        // 2. Too late: never pay a period after its window.
        if (now.getTime() >= nextDue.getTime()) {
          write("missed", { due: due.toISOString(), note: "the period ended before it could be paid" });
          report.missed++;
          report.lines.push(`${tag}: missed (period ended ${nextDue.toISOString()})`);
          continue;
        }

        if (!ev.some((e) => e.kind === "due")) write("due", { due: due.toISOString(), block: Number(await chain.blockNumber()) });

        // 3. Paid already, by a run that crashed before it could write it down (or another machine with this key).
        if (s.token === "USDC" && (await chain.authorizationState(wallet, authNonce))) {
          const dueEv = ev.find((e) => e.kind === "due");
          paidNow(await chain.findAuthorizationUsed(wallet, authNonce, BigInt(Number(dueEv?.block ?? 0))), undefined, "found on chain");
          continue;
        }

        // 4. Money for the payment and for the gas.
        const gasNeed = GAS_PER_PAYMENT * gasPrice;
        const short = (need: string, have: string, asset: string) => {
          report.short++;
          report.lines.push(`${tag}: short - needs ${need} ${asset}, wallet has ${have}`);
          if (!ev.some((e) => e.kind === "short")) write("short", { need, have, asset });
        };
        if (s.token === "USDC" && usdcLeft < value) {
          short(payee.amount, formatUnits(usdcLeft, 6), "USDC");
          continue;
        }
        if (prosLeft < gasNeed + (s.token === "PROS" ? value : 0n)) {
          short(formatUnits(gasNeed + (s.token === "PROS" ? value : 0n), 18), formatUnits(prosLeft, 18), s.token === "PROS" ? "PROS" : "PROS for gas");
          continue;
        }

        // 5. Ask the chain first: a USDC payment that would revert is not sent (and costs no gas).
        const validAfter = BigInt(Math.floor(due.getTime() / 1000)) - 1n;
        const validBefore = BigInt(Math.floor(nextDue.getTime() / 1000));
        if (s.token === "USDC") {
          const why = await chain.simulate({ from: wallet, to: USDC, data: await usdcCall(account, payee.address, value, validAfter, validBefore, authNonce) });
          if (why && /not yet valid/i.test(why)) {
            report.lines.push(`${tag}: the chain's clock is a few seconds behind; the next run pays it`);
            continue;
          }
          if (why) {
            write("failed", { reason: why, stage: "check before sending" });
            report.failed++;
            report.lines.push(`${tag}: the chain would refuse it: ${why}`);
            continue;
          }
        }

        // 6. Sign, write it down, then broadcast.
        const built = s.token === "USDC" ? await buildUsdcPayment(account, chain, { to: payee.address, value, validAfter, validBefore, nonce: authNonce }) : await buildProsPayment(account, chain, { to: payee.address, value });
        write("signed", { tx: built.hash, raw: built.raw, txNonce: built.txNonce, authNonce: s.token === "USDC" ? authNonce : undefined, gas: Number(built.gas), gasPrice: built.gasPrice.toString(), block: Number(await chain.blockNumber()) });
        try {
          await chain.sendRaw(built.raw);
        } catch (e) {
          const reason = (e as Error).message.split("\n")[0];
          if (s.token === "USDC" && !(await chain.knowsTx(built.hash))) {
            // A USDC payment can be retried freely: if the first one did land after all, the token refuses the second.
            write("failed", { tx: built.hash, reason, stage: "broadcast" });
            report.failed++;
            report.lines.push(`${tag}: the node refused it: ${reason}`);
            continue;
          }
          // PROS: an unclear answer may still mean the node took it. Keep the attempt open; the next run asks the
          // chain again and, if needed, re-sends these same bytes (which can only land once).
          if (s.token === "PROS") report.lines.push(`${tag}: unclear answer from the node (${reason}); keeping this exact tx and checking again next run`);
        }
        write("sent", { tx: built.hash });
        if (s.token === "USDC") usdcLeft -= value;
        prosLeft -= built.gas * built.gasPrice + (s.token === "PROS" ? value : 0n);
        await waitFor(built.hash);
        } catch (e) {
          // One payment that can't be checked right now (RPC down, a payee the node rejects at estimate) must not stop
          // the others. Nothing is written as failed here: an attempt already signed stays open for the next wake.
          report.lines.push(`${tag}: could not finish this time (${(e as Error).message.split("\n")[0]}); the next run tries again`);
          if (!openAttempt(ev) && /estimate|execution reverted/i.test((e as Error).message)) {
            appendJournal(home, { at: at(), series: s.id, period: p, payee: i, kind: "failed", reason: (e as Error).message.split("\n")[0], stage: "estimate" });
            report.failed++;
          }
        }
      }
    }
  }
}

const notifiedRefs = (j: JournalEvent[]) => new Set(j.filter((e) => e.kind === "notified").map((e) => String(e.ref)));

async function tellTheUser(ctx: RunCtx, report: RunReport) {
  const { home, chain, account, now, notify } = ctx;
  const journal = readJournal(home);
  const done = notifiedRefs(journal);
  const series = new Map(loadSeries(home).map((s) => [s.id, s]));
  const deliver = async (card: Card, refs: string[], s?: Series) => {
    try {
      await notify.send(card);
      for (const ref of refs) done.add(ref);
      for (const ref of refs) appendJournal(home, { at: now.toISOString(), series: s?.id ?? "*", period: -1, payee: -1, kind: "notified", ref, about: card.kind });
    } catch {
      report.undelivered++;
    }
  };
  const common = (s: Series, p: number) => ({ label: s.label, series: s.id, period: p, token: s.token, tz: s.tz });

  // Paid: one card per series and period, listing everyone paid in it.
  const groups = new Map<string, JournalEvent[]>();
  for (const e of journal.filter((e) => e.kind === "paid" && !done.has(`paid:${e.series}:${e.period}:${e.payee}`))) {
    const k = `${e.series}:${e.period}`;
    groups.set(k, [...(groups.get(k) ?? []), e]);
  }
  for (const [, evs] of groups) {
    const s = series.get(evs[0].series);
    if (!s) continue;
    const lines = evs.map((e) => ({ name: s.payees[e.payee].name, address: s.payees[e.payee].address, amount: s.payees[e.payee].amount, tx: e.tx as Hex }));
    await deliver({ kind: "paid", ...common(s, evs[0].period), at: evs[evs.length - 1].at, lines }, evs.map((e) => `paid:${e.series}:${e.period}:${e.payee}`), s);
  }

  for (const e of journal) {
    const s = series.get(e.series);
    if (!s || e.payee < 0) continue;
    const payee = s.payees[e.payee];
    const due = dueAt(s.first, s.tz, s.every, e.period).toISOString();
    if (e.kind === "short" && !done.has(`short:${e.series}:${e.period}:${e.payee}`))
      await deliver({ kind: "short", ...common(s, e.period), due, name: payee.name, amount: payee.amount, need: String(e.need), have: String(e.have), asset: String(e.asset), wallet: account.address as Hex }, [`short:${e.series}:${e.period}:${e.payee}`], s);
    if (e.kind === "missed" && !done.has(`missed:${e.series}:${e.period}:${e.payee}`))
      await deliver({ kind: "missed", ...common(s, e.period), due, name: payee.name, amount: payee.amount }, [`missed:${e.series}:${e.period}:${e.payee}`], s);
    if (e.kind === "failed" && !done.has(`failed:${e.series}:${e.period}:${e.payee}:${e.reason}`))
      await deliver({ kind: "failed", ...common(s, e.period), name: payee.name, amount: payee.amount, reason: String(e.reason), tx: e.tx as Hex | undefined }, [`failed:${e.series}:${e.period}:${e.payee}:${e.reason}`], s);
  }

  // Runway: after every payout, and whenever the next period of a series turns out short (once per period).
  const active = [...series.values()].filter((s) => s.status === "active");
  if (!active.length) return;
  const wallet = account.address as Hex;
  const [usdc, pros, gasPrice] = await Promise.all([chain.usdcBalance(wallet), chain.prosBalance(wallet), chain.gasPrice()]);
  report.runway = runway(active, { usdc, pros }, now, GAS_PER_PAYMENT * gasPrice);
  const shortRefs = report.runway.filter((l) => l.nextShort).map((l) => `runway:${l.series}:${l.nextDue}`);
  const newShort = shortRefs.filter((r) => !done.has(r));
  if (report.paid > 0 || newShort.length) await deliver({ kind: "runway", wallet, usdc: formatUnits(usdc, 6), pros: formatUnits(pros, 18), lines: report.runway }, shortRefs.length ? shortRefs : [`runway:paid:${now.toISOString()}`]);
}
