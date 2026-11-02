// The OS scheduler runs prosperDigest; nothing of ours stays running. Two entries: the report at the user's day
// and time, and a catch-up check every 6 hours (sends what is due but missed: machine off, failed send). Both
// start a small launcher script in the data folder, so the scheduler entry stays short whatever the paths are.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, posix } from "node:path";
const { join } = posix; // launchers and plists are for unix-like systems; win32 paths are built by hand
import type { Schedule } from "./store.js";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const TAG = "# prosperDigest";
// The catch-up fires at :17, never at :00, so it does not start in the same second as a report scheduled on the hour.
const CATCHUP_MIN = 17;
const CATCHUP_ST = `00:${CATCHUP_MIN}`;
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function launcher(platform: NodeJS.Platform, node: string, script: string, home: string): { name: string; body: string } {
  if (platform === "win32") return { name: "run.cmd", body: `@echo off\r\n"${node}" "${script}" --home "${home}" %*\r\n` };
  return { name: "run.sh", body: `#!/bin/sh\nexec ${sh(node)} ${sh(script)} --home ${sh(home)} "$@"\n` };
}

const launcherPath = (platform: NodeJS.Platform, home: string) => (platform === "win32" ? `${home}\\run.cmd` : join(home, "run.sh"));

/** Crontab with our tagged lines replaced (or removed); the user's other lines stay. */
export function cronText(current: string, s: Schedule, home: string, remove = false): string {
  const keep = current.split("\n").filter((l) => l.trim() && !l.includes(TAG));
  if (remove) return keep.join("\n") + (keep.length ? "\n" : "");
  const [h, m] = s.time.split(":").map(Number);
  const run = sh(launcherPath("linux", home));
  const when = s.days === 7 ? `${m} ${h} * * ${s.weekday}` : `${m} ${h} * * *`;
  return [...keep, `${when} ${run} run ${TAG}`, `${CATCHUP_MIN} */6 * * * ${run} run --catch-up ${TAG}`].join("\n") + "\n";
}

const plist = (label: string, args: string[], when: string) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${args.map((a) => `<string>${a.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`).join("")}</array>
${when}
</dict></plist>
`;

export interface SchedulerCommands {
  install: string[][];
  remove: string[][];
  files?: Record<string, string>;
}

export function schedulerCommands(platform: NodeJS.Platform, s: Schedule, home: string, userHome = ""): SchedulerCommands {
  const run = launcherPath(platform, home);
  if (platform === "win32") {
    const when = s.days === 7 ? ["/SC", "WEEKLY", "/D", DAYS[s.weekday]] : ["/SC", "DAILY"];
    return {
      install: [
        ["schtasks", "/Create", "/F", "/TN", "prosperDigest", ...when, "/ST", s.time, "/TR", `"${run}" run`],
        ["schtasks", "/Create", "/F", "/TN", "prosperDigest-catchup", "/SC", "HOURLY", "/MO", "6", "/ST", CATCHUP_ST, "/TR", `"${run}" run --catch-up`],
      ],
      remove: [
        ["schtasks", "/Delete", "/F", "/TN", "prosperDigest"],
        ["schtasks", "/Delete", "/F", "/TN", "prosperDigest-catchup"],
      ],
    };
  }
  if (platform === "darwin") {
    const dir = join(userHome, "Library", "LaunchAgents");
    const [h, m] = s.time.split(":").map(Number);
    const cal = `<key>StartCalendarInterval</key><dict>${s.days === 7 ? `<key>Weekday</key><integer>${s.weekday}</integer>` : ""}<key>Hour</key><integer>${h}</integer><key>Minute</key><integer>${m}</integer></dict>`;
    const runP = join(dir, "xyz.prosperdigest.run.plist"), catchP = join(dir, "xyz.prosperdigest.catchup.plist");
    return {
      files: {
        [runP]: plist("xyz.prosperdigest.run", [run, "run"], cal),
        [catchP]: plist("xyz.prosperdigest.catchup", [run, "run", "--catch-up"], "<key>StartInterval</key><integer>21600</integer>"),
      },
      install: [["launchctl", "unload", runP], ["launchctl", "unload", catchP], ["launchctl", "load", "-w", runP], ["launchctl", "load", "-w", catchP]],
      remove: [["launchctl", "unload", "-w", runP], ["launchctl", "unload", "-w", catchP]],
    };
  }
  // Linux and the rest: crontab, handled by applySchedule through cronText.
  return { install: [["crontab", "-"]], remove: [["crontab", "-"]] };
}

type Exec = (cmd: string, args: string[], opts?: { input?: string; encoding?: "utf8"; stdio?: unknown }) => string | Buffer;

export function applySchedule(platform: NodeJS.Platform, s: Schedule, home: string, userHome: string, remove = false, exec: Exec = execFileSync as Exec): void {
  const c = schedulerCommands(platform, s, home, userHome);
  if (platform !== "win32" && platform !== "darwin") {
    let cur = "";
    try {
      cur = String(exec("crontab", ["-l"], { encoding: "utf8" }));
    } catch {
      // no crontab yet
    }
    exec("crontab", ["-"], { input: cronText(cur, s, home, remove) });
    return;
  }
  if (!remove && c.files) for (const [f, body] of Object.entries(c.files)) writeFile(f, body);
  for (const cmd of remove ? c.remove : c.install) {
    try {
      exec(cmd[0], cmd.slice(1), { encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      // unload/delete of something not installed is fine; a failed create is not
      if (!remove && !cmd.includes("unload")) throw e;
    }
  }
}

/** What the OS scheduler currently has for us, as text. */
export function showSchedule(platform: NodeJS.Platform, userHome: string, exec: Exec = execFileSync as Exec): string {
  try {
    if (platform === "win32")
      return ["prosperDigest", "prosperDigest-catchup"]
        .map((tn) => {
          try {
            // CSV without a header: the same columns (name, next run, status) whatever the Windows language. Only the
            // first two are shown; the status text comes in the console code page and is not needed.
            const out = String(exec("schtasks", ["/Query", "/TN", tn, "/FO", "CSV", "/NH"], { encoding: "utf8", stdio: "pipe" }));
            const next = out.split(/\r?\n/).find((l) => l.trim())?.split('","')[1];
            return `${tn}: ${next ? `next run ${next}` : "installed"}`;
          } catch {
            return `${tn}: not installed`;
          }
        })
        .join("\n");
    if (platform === "darwin") {
      const dir = join(userHome, "Library", "LaunchAgents");
      return ["run", "catchup"].map((n) => `${n}: ${existsSync(join(dir, `xyz.prosperdigest.${n}.plist`)) ? "installed" : "not installed"}`).join("\n");
    }
    const lines = String(exec("crontab", ["-l"], { encoding: "utf8", stdio: "pipe" })).split("\n").filter((l) => l.includes(TAG));
    return lines.length ? lines.join("\n") : "not installed";
  } catch {
    return "not installed";
  }
}

function writeFile(f: string, body: string) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, body);
}
