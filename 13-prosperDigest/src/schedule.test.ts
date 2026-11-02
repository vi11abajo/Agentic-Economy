import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cronText, launcher, schedulerCommands, showSchedule } from "./schedule.js";
import type { Schedule } from "./store.js";

const weekly: Schedule = { days: 7, weekday: 1, time: "09:00", tz: "UTC", anchor: "2026-01-05" };
const home = "C:\\Users\\a b\\AppData\\Roaming\\prosperDigest";

describe("scheduler", () => {
  it("windows: a weekly task and a 6-hourly catch-up, both through the launcher", () => {
    const c = schedulerCommands("win32", weekly, home);
    assert.deepEqual(c.install[0], ["schtasks", "/Create", "/F", "/TN", "prosperDigest", "/SC", "WEEKLY", "/D", "MON", "/ST", "09:00", "/TR", `"${home}\\run.cmd" run`]);
    assert.deepEqual(c.install[1], ["schtasks", "/Create", "/F", "/TN", "prosperDigest-catchup", "/SC", "HOURLY", "/MO", "6", "/ST", "00:17", "/TR", `"${home}\\run.cmd" run --catch-up`]);
    assert.deepEqual(c.remove[0], ["schtasks", "/Delete", "/F", "/TN", "prosperDigest"]);
  });

  it("windows: other period lengths fire daily (a run with nothing due does nothing)", () => {
    const c = schedulerCommands("win32", { ...weekly, days: 3, time: "18:30" }, home);
    assert.deepEqual(c.install[0].slice(5, 11), ["/SC", "DAILY", "/ST", "18:30", "/TR", `"${home}\\run.cmd" run`]);
  });

  it("linux: tagged crontab lines that keep the user's own", () => {
    const t = cronText("0 1 * * * backup\n5 5 * * 1 old # prosperDigest\n", weekly, "/home/u/.config/prosperDigest");
    assert.ok(t.includes("0 1 * * * backup"));
    assert.ok(!t.includes("old"));
    assert.ok(t.includes("0 9 * * 1 '/home/u/.config/prosperDigest/run.sh' run # prosperDigest"), t);
    assert.ok(t.includes("17 */6 * * * '/home/u/.config/prosperDigest/run.sh' run --catch-up # prosperDigest"), "off the hour, so it never starts together with a report at :00");
    assert.equal(cronText(t, weekly, "/h", true).includes("prosperDigest"), false, "remove drops every tagged line");
  });

  it("macos: launch agents with the calendar time", () => {
    const c = schedulerCommands("darwin", weekly, "/Users/u/.config/prosperDigest", "/Users/u");
    const plists = Object.values(c.files!);
    assert.ok(plists[0].includes("<key>Weekday</key><integer>1</integer>"));
    assert.ok(plists[0].includes("<key>Hour</key><integer>9</integer>"));
    assert.ok(plists[1].includes("<key>StartInterval</key><integer>21600</integer>"));
  });

  it("windows: shows installed tasks whatever the system language", () => {
    const exec = ((_: string, args: string[]) => {
      if (args.includes("prosperDigest")) return '"\\prosperDigest","09.11.2026 09:00:00","\x83\xae\xe2\xae\xa2\xae"\r\n';
      throw new Error("ERROR: The system cannot find the file specified.");
    }) as never;
    const out = showSchedule("win32", "C:\\Users\\u", exec);
    assert.equal(out, "prosperDigest: next run 09.11.2026 09:00:00\nprosperDigest-catchup: not installed");
  });

  it("the launcher quotes paths with spaces and !", () => {
    const l = launcher("win32", "C:\\Program Files\\nodejs\\node.exe", "D:\\w\\!AI\\prosperDigest.mjs", home);
    assert.equal(l.name, "run.cmd");
    assert.ok(l.body.includes(`"C:\\Program Files\\nodejs\\node.exe" "D:\\w\\!AI\\prosperDigest.mjs" --home "${home}" %*`), l.body);
    const s = launcher("linux", "/usr/bin/node", "/a b/p.mjs", "/h");
    assert.ok(s.body.includes(`exec '/usr/bin/node' '/a b/p.mjs' --home '/h' "$@"`));
  });
});
