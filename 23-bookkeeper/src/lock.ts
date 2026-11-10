// One bookkeeper run at a time: the exact due wake and the regular check can start in the same minute, and two
// runs paying the same period would be one too many. The lock file is created atomically, so two processes
// started in the same second can't both get it.
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

const file = (home: string) => join(home, "run.lock");

const alive = (pid: number) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** The pid holding the lock, or null when it is free or its holder is gone. */
export function lockOwner(home: string): number | null {
  if (!existsSync(file(home))) return null;
  const pid = Number(readFileSync(file(home), "utf8"));
  return alive(pid) ? pid : null;
}

export function acquireLock(home: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file(home), "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      if (lockOwner(home) !== null) return false;
      rmSync(file(home), { force: true }); // left by a process that died
    }
  }
  return false;
}

export function releaseLock(home: string): void {
  if (existsSync(file(home)) && Number(readFileSync(file(home), "utf8")) === process.pid) rmSync(file(home), { force: true });
}
