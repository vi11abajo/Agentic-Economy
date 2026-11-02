// Periods tile time in whole UTC days from an anchor date, `days` long (7 by default). A run reports the last
// period that has fully ended; the schedule's day and time (in the user's timezone) only decide when it is sent.
import type { Schedule } from "./store.js";

export interface Period {
  key: string; // YYYY-MM-DD_Nd
  start: number; // unix seconds, inclusive
  end: number; // unix seconds, exclusive
  days: number;
  label: string; // "2026-W44" for Monday-based weeks, else "Oct 27 - Nov 2"
}

const DAY = 86_400;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function isoWeek(t: number): string {
  const d = new Date(t * 1000);
  const thu = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)));
  const jan4 = new Date(Date.UTC(thu.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thu.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${thu.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
const short = (t: number) => {
  const d = new Date(t * 1000);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
};

export function periodAt(start: number, days: number): Period {
  const end = start + days * DAY;
  const monday = new Date(start * 1000).getUTCDay() === 1;
  return { key: `${day(start)}_${days}d`, start, end, days, label: days === 7 && monday ? isoWeek(start) : `${short(start)} - ${short(end - DAY)}` };
}

export function lastClosedPeriod(nowSec: number, s: Schedule): Period {
  const anchor = Date.parse(`${s.anchor}T00:00:00Z`) / 1000;
  const len = s.days * DAY;
  const n = Math.floor((nowSec - anchor) / len) - 1;
  return periodAt(anchor + n * len, s.days);
}

export const previousPeriod = (p: Period): Period => periodAt(p.start - p.days * DAY, p.days);
export const currentPeriod = (nowSec: number, s: Schedule): Period => {
  const last = lastClosedPeriod(nowSec, s);
  return periodAt(last.end, s.days);
};

/** Wall-clock parts of a UTC instant in a timezone. */
function partsIn(tz: string, t: number) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, wd: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday) };
}

/** UTC instant of a local wall-clock time in a timezone. */
function zoned(tz: string, y: number, m: number, d: number, h: number, mi: number): number {
  let t = Date.UTC(y, m - 1, d, h, mi) / 1000;
  for (let i = 0; i < 2; i++) {
    const p = partsIn(tz, t);
    t += Date.UTC(y, m - 1, d, h, mi) / 1000 - Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi) / 1000;
  }
  return t;
}

/**
 * The anchor that lines weekly periods up with the schedule: periods end at the UTC midnight right before the
 * scheduled local time, so a Friday 18:00 digest covers Friday to Thursday and a Monday 09:00 digest east of UTC
 * (Sunday night UTC) covers the week that just ended. Other period lengths keep their anchor.
 */
export function anchorFor(s: Schedule): string {
  if (s.days !== 7) return s.anchor;
  const [h, mi] = s.time.split(":").map(Number);
  for (let i = 0; i < 7; i++) {
    const t = zoned(s.tz, 2026, 1, 5 + i, h, mi);
    if (partsIn(s.tz, t).wd === s.weekday) return day(Math.floor(t / DAY) * DAY);
  }
  return s.anchor;
}

/** When a period's digest is due: the first scheduled day/time (in s.tz) at or after the period's end. */
export function dueAt(p: Period, s: Schedule): number {
  const [h, mi] = s.time.split(":").map(Number);
  for (let i = -1; i < 15; i++) {
    const day0 = partsIn(s.tz, p.end + i * DAY);
    const t = zoned(s.tz, day0.y, day0.m, day0.d, h, mi);
    if (t < p.end) continue;
    if (s.days === 7 && partsIn(s.tz, t).wd !== s.weekday) continue;
    return t;
  }
  throw new Error("no due time found within two weeks of the period end");
}
