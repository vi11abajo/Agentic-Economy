// Plain-text views for the terminal: the plan the user says yes to, the status of every series, the journal.
// The agent reads these and retells them in the user's language; nothing here is meant to be pretty, only exact.
import { formatUnits } from "viem";
import type { RunwayLine } from "./cards.js";
import { EXPLORER_TX } from "./chain.js";
import { localTime } from "./notify.js";
import { describeEvery, dueAt, indexAt } from "./period.js";
import { paymentStates } from "./run.js";
import type { JournalEvent, Series } from "./store.js";

const checkWords = (m: number) => (m % 10080 === 0 ? "once a week" : m % 1440 === 0 ? "once a day" : m === 60 ? "once an hour" : `every ${m} minute${m === 1 ? "" : "s"}`);

export function planText(s: Series): string {
  const total = s.payees.reduce((t, p) => t + Number(p.amount), 0);
  return [
    `PLAN ${s.planId}: ${s.label}`,
    `  token: ${s.token}`,
    ...s.payees.map((p) => `  pay ${p.name} (${p.address}): ${p.amount} ${s.token}`),
    `  each time: ${+total.toFixed(18)} ${s.token} in total, plus gas in PROS`,
    `  when: ${describeEvery(s.every, s.first)} (${s.tz})`,
    `  first payment: ${localTime(dueAt(s.first, s.tz, s.every, 0).toISOString(), s.tz)}`,
    `  then: ${localTime(dueAt(s.first, s.tz, s.every, 1).toISOString(), s.tz)}, ${localTime(dueAt(s.first, s.tz, s.every, 2).toISOString(), s.tz)}, ...`,
    `  checks: ${checkWords(s.checkEveryMinutes)}, plus a wake exactly at each payment time`,
    `  runs until: the wallet runs out or you stop it`,
    ``,
    `Show this plan to the user and wait for an explicit yes. Then: bookkeeper approve ${s.planId}`,
  ].join("\n");
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function statusText(series: Series[], journal: JournalEvent[], now: Date, runway: RunwayLine[], history = 10): string {
  if (!series.length) return "No payment series yet. Tell me what to pay, to whom and how often.";
  const out: string[] = [];
  for (const s of series) {
    const states = paymentStates(s, journal, now);
    const count = (st: string) => states.filter((x) => x.status === st).length;
    out.push(`${s.label} [${s.id}] - ${s.status === "active" ? "active" : "STOPPED"}: ${s.payees.map((p) => `${p.name} ${p.amount}`).join(", ")} ${s.token}, ${describeEvery(s.every, s.first)} (${s.tz})`);
    out.push(`  paid ${count("paid")}, waiting for money ${count("short")}, sent ${count("sent")}, failed (retrying) ${count("failed")}, missed ${count("missed")}, due now ${count("due")}`);
    for (const x of states.slice(-history)) out.push(`  #${x.period + 1} ${localTime(x.due, s.tz)} ${x.name} ${x.amount} ${s.token}: ${x.status}${x.tx ? ` ${EXPLORER_TX}${x.tx}` : ""}${x.note ? ` (${x.note})` : ""}`);
    if (s.status === "active") {
      const next = indexAt(s.first, s.tz, s.every, now) + 1;
      out.push(`  next payment: #${next + 1} on ${localTime(dueAt(s.first, s.tz, s.every, next).toISOString(), s.tz)}`);
      const r = runway.find((l) => l.series === s.id);
      if (r) out.push(r.nextShort ? `  ! the wallet does not cover the next payment (${r.shortOf === "gas" ? "PROS for gas" : `${r.perPeriod} ${s.token}`})` : `  the wallet covers ${r.coversPeriods >= 52 ? "52+" : r.coversPeriods} more payment${r.coversPeriods === 1 ? "" : "s"}, until ${localTime(r.until!, s.tz)}`);
    }
    out.push("");
  }
  return out.join("\n").trimEnd();
}

/** The journal as lines a person can read; the raw signed bytes are left out. */
export function logText(journal: JournalEvent[], series: Series[]): string {
  const byId = new Map(series.map((s) => [s.id, s]));
  return journal
    .map((e) => {
      const s = byId.get(e.series);
      const who = s && e.payee >= 0 ? ` ${s.payees[e.payee]?.name} ${s.payees[e.payee]?.amount} ${s.token}` : "";
      const per = e.period >= 0 ? ` #${e.period + 1}` : "";
      const { at, series: _s, period: _p, payee: _q, kind, raw: _raw, ...rest } = e;
      const extra = Object.entries(rest)
        .filter(([, v]) => v !== undefined && v !== null)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return `${at} ${e.series}${per}${who} ${kind}${extra ? ` ${extra}` : ""}`;
    })
    .join("\n");
}

export const fmt = (v: bigint, d: number) => formatUnits(v, d);
export { short };
