#!/usr/bin/env node
// prosperDigest: a scheduled digest of Prosper activity on Pharos mainnet. Each run reads the chain for the last
// closed period (and the one before, if history doesn't have it), compares, picks the top 3 events and sends the
// digest to the user's own Telegram bot and/or Discord webhook. The OS scheduler starts it; nothing stays running.
// Exit codes: 0 ok, 1 chain or delivery failure, 2 setup needed (bad input, empty .env line).
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mcpChain } from "./chain.js";
import { DeliveryError, findTelegramChat, sendDiscord, sendTelegram } from "./deliver.js";
import { run, type RunResult } from "./digest.js";
import { num } from "./format.js";
import { PharosMcp } from "./mcp.js";
import { anchorFor, dueAt, lastClosedPeriod } from "./period.js";
import { extendRegistry, loadRegistry } from "./scan.js";
import { applySchedule, launcher, showSchedule } from "./schedule.js";
import { acquireLock, lockOwner, releaseLock } from "./lock.js";
import { DEFAULT_CONFIG, ENV_KEYS, ensureEnv, homeDir, loadConfig, log, readEnv, readHistory, saveConfig, setEnvValue } from "./store.js";
import { trends } from "./trends.js";

class Exit extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
  }
}

const HELP = `prosperDigest: a scheduled digest of Prosper activity on Pharos, sent to your Telegram and/or Discord.

  init                              create the data folder, .env with empty lines, config; start the market scan
  channels <telegram|discord|both>  where digests go
  test [telegram|discord|all]       send a test message (finds your Telegram chat after you /start the bot)
  status                            channels, .env lines filled or empty, schedule, scan progress, last digest
  run [--catch-up] [--dry] [--resend] [--period last|current]
                                    build the digest of the last closed period and send it where it's not yet
  schedule set <mon..sun|daily> <HH:MM> [--every N]   install the OS scheduler entries (local time)
  schedule show | schedule remove
  history [--weeks N]               key numbers of the last digests side by side, and trends
  scan                              bring the market list up to date (init starts it in the background)

  --home <dir>   data folder (default ${homeDir().replace(homedir(), "~")})`;

export interface Args {
  cmd: string;
  pos: string[];
  flags: Record<string, string | true>;
}

const VALUED = new Set(["home", "period", "every", "weeks"]);

export function parseArgs(argv: string[]): Args {
  const pos: string[] = [];
  const flags: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      flags[k] = VALUED.has(k) && argv[i + 1] !== undefined ? argv[++i] : true;
    } else pos.push(a);
  }
  return { cmd: flags.help ? "help" : (pos.shift() ?? "help"), pos, flags };
}

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function parseScheduleArgs(pos: string[], every: string | undefined): { days: number; weekday: number; time: string } {
  const [dayArg, timeArg] = pos.map((s) => s?.toLowerCase());
  const daily = dayArg === "daily";
  const wd = DAY_NAMES.indexOf((dayArg ?? "").slice(0, 3));
  if (!daily && wd < 0) throw new Exit(2, `day must be mon..sun or daily, got "${dayArg ?? ""}"`);
  const m = (timeArg ?? "").match(/^(\d{1,2}):(\d{2})$/);
  if (!m || +m[1] > 23 || +m[2] > 59) throw new Exit(2, `time must be HH:MM (24h), got "${timeArg ?? ""}"`);
  const n = every ? Number(every) : daily ? 1 : 7;
  if (!Number.isInteger(n) || n < 1 || n > 31) throw new Exit(2, "--every must be a whole number of days, 1 to 31");
  return { days: n, weekday: daily ? DEFAULT_CONFIG.schedule.weekday : wd, time: `${m[1].padStart(2, "0")}:${m[2]}` };
}

export function initHome(home: string, node: string, script: string, platform: NodeJS.Platform = process.platform) {
  const env = ensureEnv(home);
  if (!existsSync(join(home, "config.json"))) saveConfig(home, { ...DEFAULT_CONFIG, schedule: { ...DEFAULT_CONFIG.schedule, anchor: anchorFor(DEFAULT_CONFIG.schedule) } });
  const l = launcher(platform, node, script, home);
  writeFileSync(join(home, l.name), l.body, { mode: 0o755 });
  return { envPath: env.path, envCreated: env.created };
}

const fmtTime = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";

export function statusText(home: string, o: { head?: number; nowSec: number }): string {
  const c = loadConfig(home), s = readEnv(home), reg = loadRegistry(home);
  const filled = (v?: string) => (v ? "filled" : "empty");
  const L = [
    `data folder: ${home}`,
    `.env: ${join(home, ".env")}`,
    `telegram: ${c.channels.telegram ? "on" : "off"}, bot token ${filled(s.telegramToken)}, chat id ${filled(s.telegramChatId)}`,
    `discord: ${c.channels.discord ? "on" : "off"}, webhook ${filled(s.discordWebhook)}`,
  ];
  const sc = c.schedule;
  L.push(`schedule: ${sc.days === 7 ? `weekly, ${DAY_NAMES[sc.weekday]}` : sc.days === 1 ? "daily" : `every ${sc.days} days`} at ${sc.time} (${sc.tz}), periods of ${sc.days} day(s) in UTC`);
  const p = lastClosedPeriod(o.nowSec, sc);
  L.push(`last closed period: ${p.key} (${p.label}), due ${fmtTime(dueAt(p, sc))}`);
  const scanning = lockOwner(home);
  if (o.head) {
    const pctDone = Math.max(0, Math.min(100, ((reg.scannedTo - 17_515_617) / (o.head - 17_515_617)) * 100));
    L.push(`market scan: ${Object.keys(reg.markets).length} markets, block ${num(reg.scannedTo)} of ${num(o.head)} (${pctDone.toFixed(1)}%)${scanning ? ", running" : ""}`);
  } else L.push(`market scan: ${Object.keys(reg.markets).length} markets up to block ${num(reg.scannedTo)}${scanning ? ", running" : ""}`);
  const last = readHistory(home).at(-1);
  if (last) L.push(`last digest: ${last.key}, telegram ${last.delivered.telegram ? `sent ${last.delivered.telegram}` : last.failed?.telegram ? "FAILED" : "not sent"}, discord ${last.delivered.discord ? `sent ${last.delivered.discord}` : last.failed?.discord ? "FAILED" : "not sent"}`);
  else L.push("last digest: none yet");
  return L.join("\n");
}

async function withLock<T>(home: string, say: (s: string) => void, fn: () => Promise<T>): Promise<T> {
  for (let warned = false; !acquireLock(home); ) {
    if (!warned) say("another prosperDigest process (the market scan or a run) is working; waiting for it to finish");
    warned = true;
    await new Promise((r) => setTimeout(r, 30_000));
  }
  try {
    return await fn();
  } finally {
    releaseLock(home);
  }
}

async function withChain<T>(fn: (chain: ReturnType<typeof mcpChain>) => Promise<T>): Promise<T> {
  const mcp = new PharosMcp("prosperdigest");
  await mcp.connect();
  try {
    return await fn(mcpChain(mcp));
  } finally {
    await mcp.close().catch(() => {});
  }
}

const printResult = (r: RunResult) =>
  [`period ${r.period}: ${r.built ? "built" : "not rebuilt"}; telegram ${r.sent.telegram}, discord ${r.sent.discord}`, ...r.notes.map((n) => `  ${n}`)].join("\n");

async function main(argv: string[]): Promise<number> {
  const a = parseArgs(argv);
  const home = typeof a.flags.home === "string" ? resolve(a.flags.home) : homeDir();
  const say = (s: string) => console.log(s);
  const script = resolve(process.argv[1] ?? "prosperDigest.mjs");

  switch (a.cmd) {
    case "help":
      say(HELP);
      return 0;

    case "init": {
      const r = initHome(home, process.execPath, script);
      say(`data folder: ${home}`);
      say(`.env ${r.envCreated ? "created" : "already there"}: ${r.envPath}`);
      say(`  Telegram: fill ${ENV_KEYS.telegramToken}= (chat id is found by \`prosperDigest test telegram\`)`);
      say(`  Discord:  fill ${ENV_KEYS.discordWebhook}=`);
      if (lockOwner(home)) say("market scan: already running");
      else {
        const child = spawn(process.execPath, [script, "scan", "--home", home], { detached: true, stdio: "ignore", windowsHide: true });
        child.unref();
        say(`market scan: started in the background (pid ${child.pid}); the first one reads every Prosper market since block 17,515,618 and takes about 40 minutes. \`prosperDigest status\` shows progress.`);
      }
      return 0;
    }

    case "scan":
      return withLock(home, say, () =>
        withChain(async (chain) => {
          const head = await chain.head();
          log(home, `scan: to block ${head}`);
          const reg = await extendRegistry(chain, home, head, undefined, (to, target) => say(`scan: block ${to} of ${target}`));
          log(home, `scan: done, ${Object.keys(reg.markets).length} markets up to block ${reg.scannedTo}`);
          say(`scan done: ${Object.keys(reg.markets).length} markets up to block ${reg.scannedTo}`);
          return 0;
        }),
      );

    case "channels": {
      const which = a.pos[0];
      if (!["telegram", "discord", "both", "none"].includes(which ?? "")) throw new Exit(2, "channels <telegram|discord|both|none>");
      const c = loadConfig(home);
      c.channels = { telegram: which === "telegram" || which === "both", discord: which === "discord" || which === "both" };
      saveConfig(home, c);
      say(`digests go to: ${which === "none" ? "nowhere (reports are still saved in reports/)" : which}`);
      return 0;
    }

    case "status": {
      let head: number | undefined;
      try {
        head = await withChain((c) => c.head());
      } catch {
        // offline: status still shows the local state
      }
      say(statusText(home, { head, nowSec: Math.floor(Date.now() / 1000) }));
      say(`scheduler:\n${showSchedule(process.platform, homedir())}`);
      return 0;
    }

    case "test": {
      const which = a.pos[0] ?? "all";
      const s = readEnv(home);
      let failed = false;
      if (which === "telegram" || which === "all") {
        if (!s.telegramToken) {
          say(`telegram: ${ENV_KEYS.telegramToken} is empty in ${join(home, ".env")}`);
          failed = true;
        } else
          try {
            if (!s.telegramChatId) {
              const id = await findTelegramChat(fetch, s.telegramToken);
              if (!id) throw new DeliveryError("telegram", "no /start found", "open your bot in Telegram and send /start, then run this again");
              setEnvValue(home, ENV_KEYS.telegramChatId, id);
              s.telegramChatId = id;
              say("telegram: found your chat and saved its id to .env");
            }
            await sendTelegram(fetch, s, "✅ prosperDigest is connected. Prosper digests will arrive here.");
            say("telegram: test message sent");
          } catch (e) {
            failed = true;
            say(`telegram: FAILED: ${(e as Error).message}${e instanceof DeliveryError ? `\n  what to do: ${e.hint}` : ""}`);
          }
      }
      if (which === "discord" || which === "all") {
        if (!s.discordWebhook) {
          say(`discord: ${ENV_KEYS.discordWebhook} is empty in ${join(home, ".env")}`);
          failed = true;
        } else
          try {
            await sendDiscord(fetch, s.discordWebhook, { username: "Prosper Weekly", content: "✅ prosperDigest is connected. Prosper digests will arrive here." });
            say("discord: test message sent");
          } catch (e) {
            failed = true;
            say(`discord: FAILED: ${(e as Error).message}${e instanceof DeliveryError ? `\n  what to do: ${e.hint}` : ""}`);
          }
      }
      return failed ? 2 : 0;
    }

    case "run": {
      const period = a.flags.period === "current" ? "current" : "last";
      const r = await withLock(home, say, () =>
        withChain((chain) =>
          run(
            { chain, home, net: fetch, now: () => Math.floor(Date.now() / 1000), sleep: (ms) => new Promise((ok) => setTimeout(ok, ms)), progress: say },
            { catchUp: !!a.flags["catch-up"], dry: !!a.flags.dry, resend: !!a.flags.resend, period },
          ),
        ),
      );
      say(printResult(r));
      say(`report: ${join(home, "reports", `prosper-digest-${r.period}.html`)}`);
      return Object.values(r.sent).includes("failed") ? 1 : 0;
    }

    case "schedule": {
      const sub = a.pos[0];
      const c = loadConfig(home);
      if (sub === "set") {
        const s = parseScheduleArgs(a.pos.slice(1), typeof a.flags.every === "string" ? a.flags.every : undefined);
        c.schedule = { ...c.schedule, ...s, tz: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" };
        c.schedule.anchor = anchorFor(c.schedule);
        saveConfig(home, c);
        initHome(home, process.execPath, script);
        applySchedule(process.platform, c.schedule, home, homedir());
        say(`scheduled: ${s.days === 7 ? `every ${DAY_NAMES[s.weekday]}` : s.days === 1 ? "every day" : `every ${s.days} days`} at ${s.time} local time, plus a catch-up check every 6 hours`);
        say(showSchedule(process.platform, homedir()));
        return 0;
      }
      if (sub === "remove") {
        applySchedule(process.platform, c.schedule, home, homedir(), true);
        say("schedule removed");
        return 0;
      }
      if (sub === "show" || !sub) {
        say(showSchedule(process.platform, homedir()));
        return 0;
      }
      throw new Exit(2, "schedule set <mon..sun|daily> <HH:MM> [--every N] | show | remove");
    }

    case "history": {
      const n = Number(typeof a.flags.weeks === "string" ? a.flags.weeks : 8);
      const h = readHistory(home).sort((x, y) => x.start - y.start).slice(-n);
      if (!h.length) {
        say("no digests yet");
        return 0;
      }
      const rows: Array<[string, (m: (typeof h)[0]["metrics"]) => number]> = [
        ["volume (PROS)", (m) => m.volume], ["net flow", (m) => m.netFlow], ["trades", (m) => m.trades], ["traders", (m) => m.traders],
        ["new traders", (m) => m.newTraders], ["fees", (m) => m.fees], ["new markets", (m) => m.newMarkets], ["graduated", (m) => m.graduated], ["on curve", (m) => m.onCurve],
      ];
      const w = 14;
      say(["".padEnd(15), ...h.map((d) => d.label.padStart(w))].join(""));
      for (const [name, f] of rows) say([name.padEnd(15), ...h.map((d) => num(f(d.metrics)).padStart(w))].join(""));
      const t = trends(h.slice(0, -1), h.at(-1)!.metrics, h.at(-1)!.days);
      say(t.length ? `trends:\n${t.map((x) => `  ${x}`).join("\n")}` : "trends: need at least 4 digests of the same length");
      return 0;
    }

    default:
      throw new Exit(2, `unknown command "${a.cmd}"\n\n${HELP}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("prosperDigest.mjs")) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof Exit) {
        console.error(e.message);
        process.exit(e.code);
      }
      console.error(`error: ${(e as Error).message}`);
      process.exit(1);
    });
}
