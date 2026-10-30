// The memory: one folder per watch with its settings, every observation (observations.jsonl), the candles the
// EMA filter needs (bars-<tf>.jsonl) and every signal (signals.jsonl). Lines are keyed: a key already stored is
// never written again, so a rerun or a restart can't duplicate anything, and a half-written last line (a crash
// mid-write) is dropped and rewritten on the next run.
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Rule } from "./rules.js";

export interface Watch {
  name: string;
  source: string; // okx:<instId> or pharos-pool:<address>
  bar: string; // okx: the candle timeframe of one observation
  base?: string; // pharos-pool: the token whose price is watched
  every_blocks?: number; // pharos-pool: one observation every N blocks
  since: string; // ISO date the history starts from
  rule: Rule;
  on_trigger?: string; // a command to run once per new signal
  created: string;
}

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TRENDWATCH_HOME) return env.TRENDWATCH_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "trendwatch");
}

export function displayPath(p: string, home = homedir()): string {
  return (p.startsWith(home) ? `~${p.slice(home.length)}` : p).replace(/\\/g, "/");
}

const dir = (home: string, name: string) => join(home, "watches", name);

export function listWatches(home: string): string[] {
  const d = join(home, "watches");
  return existsSync(d) ? readdirSync(d).filter((n) => existsSync(join(d, n, "watch.json"))).sort() : [];
}

export function loadWatch(home: string, name: string): Watch | null {
  const f = join(dir(home, name), "watch.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Watch) : null;
}

export function saveWatch(home: string, w: Watch): void {
  mkdirSync(dir(home, w.name), { recursive: true });
  const f = join(dir(home, w.name), "watch.json");
  writeFileSync(`${f}.tmp`, `${JSON.stringify(w, null, 2)}\n`);
  renameSync(`${f}.tmp`, f);
}

export function removeWatch(home: string, name: string): void {
  rmSync(dir(home, name), { recursive: true, force: true });
}

/** A keyed log: reads every complete line, drops a torn last line, appends only keys it doesn't have. */
export class KeyedLog<T extends { key: string }> {
  private readonly file: string;
  private readonly items = new Map<string, T>();
  repaired = false;

  constructor(home: string, name: string, file: string) {
    mkdirSync(dir(home, name), { recursive: true });
    this.file = join(dir(home, name), file);
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    const lines = text.split("\n");
    const good: string[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const x = JSON.parse(line) as T;
        if (!this.items.has(x.key)) this.items.set(x.key, x);
        good.push(line);
      } catch {
        this.repaired = true; // a line cut off by a crash: it wasn't committed, so it goes
      }
    }
    if (this.repaired || (text.length && !text.endsWith("\n"))) {
      writeFileSync(`${this.file}.tmp`, good.map((l) => `${l}\n`).join(""));
      renameSync(`${this.file}.tmp`, this.file);
    }
  }

  has(key: string): boolean {
    return this.items.has(key);
  }

  /** Sorted by key (keys are zero-padded numbers, so this is time order). */
  all(): T[] {
    return [...this.items.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  last(): T | undefined {
    const a = this.all();
    return a[a.length - 1];
  }

  /** Appends the new ones in one write; returns how many were new. */
  add(xs: T[]): number {
    const fresh = xs.filter((x) => !this.items.has(x.key));
    if (!fresh.length) return 0;
    appendFileSync(this.file, fresh.map((x) => `${JSON.stringify(x)}\n`).join(""));
    for (const x of fresh) this.items.set(x.key, x);
    return fresh.length;
  }
}

/** One run at a time: a lock file made with O_EXCL. A lock older than 15 minutes is a crashed run's and is taken over. */
export function lock(home: string): () => void {
  mkdirSync(home, { recursive: true });
  const f = join(home, "run.lock");
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, "wx");
      writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      closeSync(fd);
      return () => rmSync(f, { force: true });
    } catch {
      if (Date.now() - statSync(f).mtimeMs > 15 * 60_000) rmSync(f, { force: true });
      else throw new Error(`another trendwatch run holds ${displayPath(f)} (started ${readFileSync(f, "utf8").trim()})`);
    }
  }
  throw new Error(`can't take ${displayPath(f)}`);
}
