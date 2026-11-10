// When is payment number N due? A schedule is "the first payment at this wall clock time in this timezone, then
// every N units". Days, weeks and months follow the user's wall clock (payday stays 09:00 after a DST change);
// minutes and hours are plain arithmetic. Months always count from the first payment's day, so a series that starts
// on the 31st pays on Feb 28 and then goes back to Mar 31 instead of drifting to the 28th forever.

export type Unit = "minute" | "hour" | "day" | "week" | "month";
export interface Every {
  n: number;
  unit: Unit;
}

interface Wall {
  y: number;
  mo: number; // 1-12
  d: number;
  h: number;
  mi: number;
}

const MINUTE = 60_000;

export function parseWall(first: string): Wall {
  const m = first.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/);
  if (!m) throw new Error(`first payment must look like 2026-11-13T09:00 (local time), got "${first}"`);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5] };
}

/** How far ahead of UTC the zone is at this instant, in ms. */
function offsetAt(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - Math.floor(ms / 1000) * 1000;
}

/** The instant a wall clock time happens in a zone. A time skipped by DST moves forward, like most calendars do. */
export function wallToDate(w: Wall, tz: string): Date {
  const naive = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  let guess = naive - offsetAt(naive, tz);
  guess = naive - offsetAt(guess, tz);
  return new Date(guess);
}

const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

export function dueAt(first: string, tz: string, every: Every, index: number): Date {
  const w = parseWall(first);
  const start = wallToDate(w, tz);
  if (every.unit === "minute") return new Date(start.getTime() + index * every.n * MINUTE);
  if (every.unit === "hour") return new Date(start.getTime() + index * every.n * 60 * MINUTE);
  if (every.unit === "month") {
    const months = w.mo - 1 + index * every.n;
    const y = w.y + Math.floor(months / 12);
    const mo = (months % 12) + 1;
    return wallToDate({ ...w, y, mo, d: Math.min(w.d, daysIn(y, mo)) }, tz);
  }
  const days = index * every.n * (every.unit === "week" ? 7 : 1);
  const shifted = new Date(Date.UTC(w.y, w.mo - 1, w.d + days));
  return wallToDate({ ...w, y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() }, tz);
}

const roughLength: Record<Unit, number> = { minute: MINUTE, hour: 60 * MINUTE, day: 1440 * MINUTE, week: 7 * 1440 * MINUTE, month: 28 * 1440 * MINUTE };

/** The latest payment index whose due time has come, or -1 before the first one. */
export function indexAt(first: string, tz: string, every: Every, now: Date): number {
  const t = now.getTime();
  if (t < dueAt(first, tz, every, 0).getTime()) return -1;
  let i = Math.max(0, Math.floor((t - dueAt(first, tz, every, 0).getTime()) / (roughLength[every.unit] * every.n)) - 1);
  while (dueAt(first, tz, every, i + 1).getTime() <= t) i++;
  while (i > 0 && dueAt(first, tz, every, i).getTime() > t) i--;
  return i;
}

/**
 * How often the bookkeeper wakes to check, by the user's rule: one unit below the period (monthly -> weekly,
 * weekly -> daily, daily -> hourly), never rarer than hourly for hour periods, and for anything under an hour the
 * agent proposes an interval and the user agrees it (null until then). The exact due moment gets its own wake.
 */
export function checkEveryMinutes(every: Every, agreed?: number): number | null {
  switch (every.unit) {
    case "month":
      return 7 * 1440;
    case "week":
      return 1440;
    case "day":
    case "hour":
      return 60;
    case "minute":
      return every.n >= 60 ? 60 : agreed && agreed > 0 ? agreed : null;
  }
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const ordinal = (d: number) => `${d}${d % 10 === 1 && d !== 11 ? "st" : d % 10 === 2 && d !== 12 ? "nd" : d % 10 === 3 && d !== 13 ? "rd" : "th"}`;
const pad = (x: number) => String(x).padStart(2, "0");

export function describeEvery(every: Every, first: string): string {
  const w = parseWall(first);
  const at = `${pad(w.h)}:${pad(w.mi)}`;
  const n = every.n === 1 ? every.unit : `${every.n} ${every.unit}s`;
  if (every.unit === "minute" || every.unit === "hour") return `every ${n}`;
  if (every.unit === "day") return `every ${n} at ${at}`;
  if (every.unit === "week") return `every ${n} on ${WEEKDAYS[new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay()]} at ${at}`;
  return `every ${n} on the ${ordinal(w.d)} at ${at}${w.d > 28 ? " (last day in shorter months)" : ""}`;
}
