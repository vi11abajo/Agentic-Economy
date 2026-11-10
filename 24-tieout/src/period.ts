// Turning "1 to 10 November, Moscow time" into the two blocks the report stands on.
//
// The opening balance is the state after the last block that closed BEFORE the period started, the closing balance
// is the state after the last block that closed inside it. Everything in between belongs to the period. Pharos makes
// about one block a second, so a day is roughly 89k blocks and the search below needs some 25 block lookups.

export interface Period {
  /** First second that belongs to the period (unix seconds). */
  from: number;
  /** Last second that belongs to the period (unix seconds, inclusive). */
  to: number;
  /** The offset the user's dates were given in, e.g. "+03:00" or "UTC". Only for printing. */
  zone: string;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const OFFSET = /^([+-])(\d{2}):?(\d{2})$/;

/** Minutes east of UTC for "UTC", "Z", "+03:00", "-0500". */
export function offsetMinutes(zone: string): number {
  if (/^(utc|z|gmt)$/i.test(zone)) return 0;
  const m = OFFSET.exec(zone);
  if (!m) throw new Error(`can't read the time zone "${zone}": use UTC or an offset like +03:00`);
  const minutes = Number(m[2]) * 60 + Number(m[3]);
  return m[1] === "-" ? -minutes : minutes;
}

const normalZone = (zone: string) => {
  const off = offsetMinutes(zone);
  if (off === 0) return "UTC";
  const a = Math.abs(off);
  return `${off < 0 ? "-" : "+"}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
};

// A bare date means the whole day in the user's zone; a full timestamp is taken as is.
function edge(text: string, zone: string, end: boolean): number {
  if (DATE_ONLY.test(text)) {
    const midnightUtc = Date.parse(`${text}T00:00:00Z`) / 1000;
    if (Number.isNaN(midnightUtc)) throw new Error(`"${text}" is not a date`);
    const start = midnightUtc - offsetMinutes(zone) * 60;
    return end ? start + 86400 - 1 : start;
  }
  const hasZone = /(z|[+-]\d{2}:?\d{2})$/i.test(text);
  const ms = Date.parse(hasZone ? text : `${text}${normalZone(zone) === "UTC" ? "Z" : normalZone(zone)}`);
  if (Number.isNaN(ms)) throw new Error(`"${text}" is not a date or a time`);
  return Math.floor(ms / 1000);
}

export function readPeriod(fromText: string, toText: string, zone = "UTC"): Period {
  const from = edge(fromText, zone, false);
  const to = edge(toText, zone, true);
  if (to < from) throw new Error(`the period ends (${toText}) before it starts (${fromText})`);
  return { from, to, zone: normalZone(zone) };
}

/** "2026-11-01 00:00" in the period's own zone, so the report shows the times the user asked for. */
export function localTime(unix: number, zone: string, withSeconds = false): string {
  const shifted = new Date((unix + offsetMinutes(zone) * 60) * 1000).toISOString();
  return shifted.slice(0, 10) + " " + shifted.slice(11, withSeconds ? 19 : 16);
}

/**
 * The last block whose timestamp is <= t. Blocks only move forward in time, so a plain binary search over the
 * block numbers works. `timeOf` is asked for a block's timestamp; `head` is the newest block.
 */
export async function lastBlockAtOrBefore(t: number, head: bigint, timeOf: (n: bigint) => Promise<number>): Promise<bigint> {
  if ((await timeOf(head)) <= t) return head;
  let lo = 0n; // genesis: assume it's older than anything anyone asks about
  let hi = head; // known to be after t
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await timeOf(mid)) <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}
