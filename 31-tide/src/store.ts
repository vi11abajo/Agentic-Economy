// tide's folder: jobs.json (every tx it is holding or has sent) and samples.jsonl (every gas reading it took).
// Kept outside the repo. A job survives a restart: `tide resume` picks up where it stopped.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Sample } from "./gas.js";
import type { Job } from "./hold.js";

export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.TIDE_HOME) return env.TIDE_HOME;
  const base = process.platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "tide");
}

export class Store {
  constructor(readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  private get jobsFile() {
    return join(this.dir, "jobs.json");
  }

  jobs(): Job[] {
    return existsSync(this.jobsFile) ? (JSON.parse(readFileSync(this.jobsFile, "utf8")) as Job[]) : [];
  }

  save(job: Job): void {
    const all = this.jobs().filter((j) => j.id !== job.id);
    all.push(job);
    const tmp = `${this.jobsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(all, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    renameSync(tmp, this.jobsFile);
  }

  record(s: Sample): void {
    appendFileSync(join(this.dir, "samples.jsonl"), JSON.stringify(s) + "\n");
  }

  samples(network: string, sinceIso: string): Sample[] {
    const f = join(this.dir, "samples.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Sample)
      .filter((s) => s.network === network && s.at >= sinceIso);
  }
}
