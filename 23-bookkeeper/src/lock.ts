// One bookkeeper run at a time: the exact due wake and the regular check can start in the same minute, and two
// runs paying the same period would be one too many.
//
// The lock file says "pid startedAtMs". It is written to a side file first and then linked into place, so nobody
// ever sees it half written, and the link fails if a lock is already there. A lock counts as stale when its process
// is gone or when it is older than any run may last (Task Scheduler kills a run after 30 minutes; Windows reuses
// pids, so a live pid alone proves nothing). Breaking a stale lock goes through a rename that only one process can
// win, and the winner checks it took the lock it judged stale and not a fresh one.
import { existsSync, linkSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = (home: string) => join(home, "run.lock");
export const LOCK_MAX_AGE_MS = 35 * 60_000;

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

function stale(text: string, mtimeMs: number, now: number): boolean {
  const [pid, started] = text.trim().split(/\s+/).map(Number);
  // empty or garbled: someone is writing it right now, unless it has been like that for ages
  if (!pid || !started) return now - mtimeMs > LOCK_MAX_AGE_MS;
  return !alive(pid) || now - started > LOCK_MAX_AGE_MS;
}

/** The pid holding the lock, or null when it is free or stale. */
export function lockOwner(home: string, now = Date.now()): number | null {
  const f = file(home);
  if (!existsSync(f)) return null;
  const text = readFileSync(f, "utf8");
  return stale(text, statSync(f).mtimeMs, now) ? null : Number(text.split(/\s+/)[0]) || -1;
}

export function acquireLock(home: string, now = Date.now()): boolean {
  const f = file(home);
  const mine = `${f}.${process.pid}.${now}`;
  writeFileSync(mine, `${process.pid} ${now}`);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        linkSync(mine, f);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      let text: string, mtime: number;
      try {
        text = readFileSync(f, "utf8");
        mtime = statSync(f).mtimeMs;
      } catch {
        continue; // released between our link and our read: just try again
      }
      if (!stale(text, mtime, now)) return false;
      const grave = `${f}.stale.${process.pid}.${now}`;
      try {
        renameSync(f, grave);
      } catch {
        return false; // another process is breaking it; let it have the run
      }
      if (readFileSync(grave, "utf8") !== text) {
        // We moved a fresh lock someone took after our read: put it back and step aside.
        try {
          linkSync(grave, f);
        } catch {
          // a third process got in; it holds the lock now
        }
        rmSync(grave, { force: true });
        return false;
      }
      rmSync(grave, { force: true });
    }
    return false;
  } finally {
    rmSync(mine, { force: true });
  }
}

export function releaseLock(home: string): void {
  const f = file(home);
  if (existsSync(f) && Number(readFileSync(f, "utf8").split(/\s+/)[0]) === process.pid) rmSync(f, { force: true });
}
