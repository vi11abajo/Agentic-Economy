// The OS scheduler wakes the bookkeeper; nothing of ours stays running. Two entries:
//   bookkeeper-check  the regular check, by the user's rule (monthly -> weekly, weekly -> daily, daily/hourly ->
//                     hourly, faster -> the interval agreed with the user), anchored at the first payment time;
//   bookkeeper-due    one exact wake at the next payment moment, re-armed by every run.
// On Windows both are Task Scheduler tasks created from XML: dates in XML are ISO, so the task looks the same on a
// Russian or an English Windows (schtasks /SD would want the local date format). StartWhenAvailable makes a wake
// that fell while the PC was off run as soon as it is back.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dueAt, indexAt } from "./period.js";
import type { Series } from "./store.js";

export interface SchedulePlan {
  checkEveryMinutes: number;
  anchor: Date; // first payment of the series that needs the most frequent check
  nextDue: Date | null;
}

export function scheduleFor(series: Series[], now: Date): SchedulePlan | null {
  const active = series.filter((s) => s.status === "active");
  if (!active.length) return null;
  const fastest = [...active].sort((a, b) => a.checkEveryMinutes - b.checkEveryMinutes)[0];
  const next = active.map((s) => dueAt(s.first, s.tz, s.every, indexAt(s.first, s.tz, s.every, now) + 1));
  return { checkEveryMinutes: fastest.checkEveryMinutes, anchor: dueAt(fastest.first, fastest.tz, fastest.every, 0), nextDue: new Date(Math.min(...next.map((d) => d.getTime()))) };
}

const pad = (x: number) => String(x).padStart(2, "0");
/** The machine's local wall clock, which is what Task Scheduler and cron read. */
const localIso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const interval = (m: number) => (m % 1440 === 0 ? `P${m / 1440}D` : `PT${m}M`);
const xmlEsc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function taskXml(kind: "check" | "due", p: SchedulePlan, launcher: string): string {
  const start = kind === "check" ? p.anchor : p.nextDue!;
  const repeat = kind === "check" ? `<Repetition><Interval>${interval(p.checkEveryMinutes)}</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>` : "";
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>bookkeeper: ${kind === "check" ? "regular check for due payments" : "wake at the next payment moment"}</Description></RegistrationInfo>
  <Triggers><TimeTrigger><StartBoundary>${localIso(start)}</StartBoundary>${repeat}<Enabled>true</Enabled></TimeTrigger></Triggers>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT30M</ExecutionTimeLimit>
    <Enabled>true</Enabled>
  </Settings>
  <Actions><Exec><Command>${xmlEsc(launcher)}</Command><Arguments>run</Arguments></Exec></Actions>
</Task>
`;
}

const TAG = "# bookkeeper";
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The crontab with our lines replaced (or removed when p is null); the user's other lines stay. */
export function cronLines(current: string, p: SchedulePlan | null, launcher: string): string {
  const keep = current.split("\n").filter((l) => l.trim() && !l.includes(TAG));
  if (!p) return keep.join("\n") + (keep.length ? "\n" : "");
  const a = p.anchor, m = p.checkEveryMinutes;
  const when = m < 60 ? `*/${m} * * * *` : m < 1440 ? `${a.getMinutes()} * * * *` : m < 10080 ? `${a.getMinutes()} ${a.getHours()} * * *` : `${a.getMinutes()} ${a.getHours()} * * ${a.getDay()}`;
  const out = [...keep, `${when} ${sh(launcher)} run ${TAG}`];
  if (p.nextDue) out.push(`${p.nextDue.getMinutes()} ${p.nextDue.getHours()} ${p.nextDue.getDate()} ${p.nextDue.getMonth() + 1} * ${sh(launcher)} run ${TAG}`);
  return out.join("\n") + "\n";
}

export function launcher(platform: NodeJS.Platform, node: string, script: string, home: string): { path: string; body: string } {
  if (platform === "win32") return { path: join(home, "run.cmd"), body: `@echo off\r\n"${node}" "${script}" --home "${home}" %* >> "${join(home, "run.log")}" 2>&1\r\n` };
  return { path: join(home, "run.sh"), body: `#!/bin/sh\nexec ${sh(node)} ${sh(script)} --home ${sh(home)} "$@" >> ${sh(join(home, "run.log"))} 2>&1\n` };
}

type Exec = (cmd: string, args: string[], opts?: object) => string | Buffer;
const TASKS = ["bookkeeper-check", "bookkeeper-due"] as const;

/** Puts the plan into the OS scheduler (or removes our entries when p is null). */
export function applySchedule(p: SchedulePlan | null, home: string, platform: NodeJS.Platform = process.platform, exec: Exec = execFileSync as Exec): string[] {
  const done: string[] = [];
  const run = launcher(platform, process.execPath, process.argv[1] ?? "", home).path;
  if (platform === "win32") {
    for (const name of TASKS) {
      const kind = name === "bookkeeper-check" ? "check" : "due";
      if (!p || (kind === "due" && !p.nextDue)) {
        try {
          exec("schtasks", ["/Delete", "/F", "/TN", name], { stdio: "pipe" });
          done.push(`${name}: removed`);
        } catch {
          // not there, fine
        }
        continue;
      }
      const file = join(home, `${name}.xml`);
      // Task Scheduler reads task XML as UTF-16 with a byte order mark.
      writeFileSync(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(kind, p, run), "utf16le")]));
      exec("schtasks", ["/Create", "/F", "/TN", name, "/XML", file], { stdio: "pipe" });
      done.push(`${name}: ${kind === "check" ? `every ${p.checkEveryMinutes} min from ${localIso(p.anchor)}` : `once at ${localIso(p.nextDue!)}`}`);
    }
    return done;
  }
  let cur = "";
  try {
    cur = String(exec("crontab", ["-l"], { encoding: "utf8", stdio: "pipe" }));
  } catch {
    // no crontab yet
  }
  exec("crontab", ["-"], { input: cronLines(cur, p, run) });
  done.push(p ? "crontab: bookkeeper lines written" : "crontab: bookkeeper lines removed");
  return done;
}

/** What the scheduler has for us now, read back from it. */
export function showSchedule(platform: NodeJS.Platform = process.platform, exec: Exec = execFileSync as Exec): string[] {
  if (platform === "win32")
    return TASKS.map((tn) => {
      try {
        // CSV without a header has the same columns whatever the Windows language: name, next run, status.
        const out = String(exec("schtasks", ["/Query", "/TN", tn, "/FO", "CSV", "/NH"], { encoding: "utf8", stdio: "pipe" }));
        const next = out.split(/\r?\n/).find((l) => l.trim())?.split('","')[1];
        return `${tn}: ${next ? `next run ${next}` : "installed"}`;
      } catch {
        return `${tn}: not installed`;
      }
    });
  try {
    const lines = String(exec("crontab", ["-l"], { encoding: "utf8", stdio: "pipe" })).split("\n").filter((l) => l.includes(TAG));
    return lines.length ? lines : ["not installed"];
  } catch {
    return ["not installed"];
  }
}

export function writeLauncher(home: string, script: string, platform: NodeJS.Platform = process.platform): string {
  const l = launcher(platform, process.execPath, script, home);
  mkdirSync(home, { recursive: true });
  if (!existsSync(l.path) || readFileSync(l.path, "utf8") !== l.body) writeFileSync(l.path, l.body, { mode: 0o755 });
  return l.path;
}
