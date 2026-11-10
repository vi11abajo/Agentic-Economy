#!/usr/bin/env node
// bookkeeper: recurring payments on Pharos from the bookkeeper's own wallet, once the user approves the plan.
//   init [--new-key]         .env with empty lines for the user to fill (or a fresh wallet), launcher
//   settings                 which .env lines are filled (names only)
//   wallet                   address, balances, how long the money lasts
//   draft <file.json|->      what the agent understood -> open questions, or the plan to show the user
//   approve <planId>         the user said yes: switch it on, put it in the OS scheduler, pay if already due
//   run [--no-schedule]      one wake: pay what is due, tell Telegram/Discord, re-arm the next wake
//   status [--json]          every series: history, counts, next payment
//   log [--series id] [--since ISO] [--json]
//   stop <id> | resume <id>
//   notify-test              send a test card (and find the Telegram chat id after /start)
//   schedule show|install|remove
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { formatUnits } from "viem";
import { viemChain } from "./chain.js";
import { findTelegramChat, makeNotifier } from "./notify.js";
import { dueAt } from "./period.js";
import { approve, draft, type DraftInput } from "./plan.js";
import { logText, planText, statusText } from "./render.js";
import { GAS_PER_PAYMENT, runOnce, runway } from "./run.js";
import { applySchedule, scheduleFor, showSchedule, writeLauncher } from "./schedule.js";
import { ENV_KEYS, appendJournal, homeDir, initHome, loadPeople, loadSeries, readJournal, readSecrets, saveSeries, type Hex } from "./store.js";

const HELP = `bookkeeper: recurring payments on Pharos from its own wallet, once you approve the plan
  init [--new-key]         data folder, .env with empty lines to fill (or a fresh wallet), launcher
  settings                 which .env lines are filled (names only, never values)
  wallet                   address, balances, how long the money lasts
  draft <file.json|->      what the agent understood -> open questions, or the plan to show the user
  approve <planId>         the user said yes: switch it on, put it in the OS scheduler, pay if already due
  run [--no-schedule]      one wake: pay what is due, tell Telegram/Discord, re-arm the next wake
  status [--json]          every series: history, counts, next payment
  log [--series id] [--since ISO] [--json]
  stop <id> | resume <id>
  notify-test              send a test message (and find the Telegram chat id after /start)
  schedule show|install|remove
  --home <dir>             data folder (default %APPDATA%\\bookkeeper or ~/.config/bookkeeper)`;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const bool = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return false;
  argv.splice(i, 1);
  return true;
};
const home = flag("--home") ?? homeDir();
const [cmd, arg] = argv;
const print = (s: string) => process.stdout.write(s + "\n");

function wallet() {
  const key = readSecrets(home).privateKey;
  if (!key) throw new Error(`No wallet key in ${join(home, ".env")} (${ENV_KEYS.privateKey}). Run bookkeeper init, or paste a key there yourself.`);
  return privateKeyToAccount(key);
}

/** Which settings lines are filled - names only, never the values. */
function envState(): string {
  const s = readSecrets(home);
  const line = (k: string, ok: boolean, what: string) => `  ${k}: ${ok ? "filled" : `EMPTY - ${what}`}`;
  return [
    `settings (${join(home, ".env")}):`,
    line(ENV_KEYS.privateKey, !!s.privateKey, "the private key of the wallet that pays"),
    line(ENV_KEYS.telegramToken, !!s.telegramToken, "Telegram bot token (optional if Discord is set)"),
    line(ENV_KEYS.telegramChatId, !!s.telegramChatId, "filled by notify-test after /start to the bot"),
    line(ENV_KEYS.discordWebhook, !!s.discordWebhook, "Discord webhook URL (optional if Telegram is set)"),
  ].join("\n");
}

function reschedule(now: Date): string[] {
  try {
    return applySchedule(scheduleFor(loadSeries(home), now), home);
  } catch (e) {
    return [`could not update the OS scheduler: ${(e as Error).message.split("\n")[0]}. Run \`bookkeeper schedule install\` yourself.`];
  }
}

async function wake(now: Date, schedule: boolean) {
  const s = readSecrets(home);
  const report = await runOnce({ home, chain: viemChain(), account: wallet(), now, notify: makeNotifier(s) });
  if (report.skipped) return print(`${now.toISOString()} another bookkeeper run is going on; this one did nothing`);
  print(`${now.toISOString()} run: paid ${report.paid}, short ${report.short}, failed ${report.failed}, missed ${report.missed}`);
  for (const l of report.lines) print(`  ${l}`);
  if (report.undelivered) print(`  ${report.undelivered} message(s) to Telegram/Discord did not go out; the next run tries again`);
  if (!makeNotifier(s).channels.length) print("  Telegram and Discord are not set up, so nobody was told. Fill them in .env and run bookkeeper notify-test.");
  for (const r of report.runway) print(`  ${r.label}: ${r.nextShort ? `NEXT PAYMENT NOT COVERED (${r.perPeriod} ${r.token})` : `covers ${r.coversPeriods >= 52 ? "52+" : r.coversPeriods} more`}`);
  if (report.nextDue) print(`  next payment: ${report.nextDue}`);
  if (schedule) for (const l of reschedule(now)) print(`  scheduler: ${l}`);
}

async function main() {
  const now = new Date();
  switch (cmd) {
    case "init": {
      // By default the user brings the wallet: the .env gets an empty key line they fill in themselves.
      // --new-key makes a fresh wallet instead (its key is written to the file and never printed).
      const r = initHome(home, bool("--new-key") ? () => generatePrivateKey() : null);
      const run = writeLauncher(home, process.argv[1]);
      print(`data folder: ${home}`);
      print(`settings file: ${r.envPath} (never paste its contents into a chat)`);
      print(r.address ? `paying wallet: ${r.address}${r.created ? " (new key made just now)" : " (key already there, kept)"}` : `no wallet key yet`);
      print(`launcher for the OS scheduler: ${run}`);
      print(envState());
      return;
    }
    case "settings":
      return print(envState());
    case "wallet": {
      const a = wallet().address as Hex;
      const c = viemChain();
      const [usdc, pros, gp] = await Promise.all([c.usdcBalance(a), c.prosBalance(a), c.gasPrice()]);
      print(`paying wallet ${a}: ${formatUnits(usdc, 6)} USDC, ${formatUnits(pros, 18)} PROS`);
      for (const r of runway(loadSeries(home), { usdc, pros }, now, GAS_PER_PAYMENT * gp)) print(`  ${r.label}: ${r.perPeriod} ${r.token} per period; ${r.nextShort ? "the next payment is NOT covered" : `covers ${r.coversPeriods >= 52 ? "52+" : r.coversPeriods} more, until ${r.until}`}`);
      return;
    }
    case "draft": {
      if (!arg) throw new Error("draft needs a JSON file (or - for stdin) with what the user asked for");
      const input = JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8")) as DraftInput;
      const r = draft(input, loadPeople(home), now, home);
      if ("missing" in r) {
        print("STILL NEED (ask the user, one at a time):");
        for (const q of r.missing) print(`- ${q}`);
        process.exitCode = 2;
      } else print(planText(r.plan));
      return;
    }
    case "approve": {
      if (!arg) throw new Error("approve needs the plan id from draft");
      const s = approve(home, arg, now);
      print(`approved: ${s.label} [${s.id}] is on.`);
      writeLauncher(home, process.argv[1]);
      for (const l of reschedule(now)) print(`scheduler: ${l}`);
      // "starting now": the first payment is due already, so pay it in this same step instead of waiting for a wake.
      if (dueAt(s.first, s.tz, s.every, 0).getTime() <= Date.now()) await wake(new Date(), false);
      else print(`first payment: ${dueAt(s.first, s.tz, s.every, 0).toISOString()}`);
      return;
    }
    case "run":
      return wake(now, !bool("--no-schedule"));
    case "status": {
      const series = loadSeries(home);
      const json = bool("--json");
      let lines: ReturnType<typeof runway> = [];
      try {
        const a = wallet().address as Hex;
        const c = viemChain();
        const [usdc, pros, gp] = await Promise.all([c.usdcBalance(a), c.prosBalance(a), c.gasPrice()]);
        lines = runway(series, { usdc, pros }, now, GAS_PER_PAYMENT * gp);
        if (!json) print(`paying wallet ${a}: ${formatUnits(usdc, 6)} USDC, ${formatUnits(pros, 18)} PROS\n`);
      } catch (e) {
        if (!json) print(`(wallet not read: ${(e as Error).message.split("\n")[0]})\n`);
      }
      if (json) print(JSON.stringify({ series, runway: lines, journal: readJournal(home).map(({ raw: _r, ...e }) => e) }, null, 2));
      else print(statusText(series, readJournal(home), now, lines));
      return;
    }
    case "log": {
      const only = flag("--series"), since = flag("--since");
      const json = bool("--json");
      const j = readJournal(home).filter((e) => (!only || e.series === only) && (!since || e.at >= since));
      print(json ? JSON.stringify(j.map(({ raw: _r, ...e }) => e), null, 2) : logText(j, loadSeries(home)) || "the journal is empty");
      return;
    }
    case "stop":
    case "resume": {
      const all = loadSeries(home);
      const s = all.find((x) => x.id === arg);
      if (!s) throw new Error(`no series "${arg}"; known: ${all.map((x) => x.id).join(", ") || "none"}`);
      s.status = cmd === "stop" ? "stopped" : "active";
      saveSeries(home, all);
      appendJournal(home, { at: now.toISOString(), series: s.id, period: -1, payee: -1, kind: cmd === "stop" ? "stopped" : "resumed" });
      print(`${s.label} [${s.id}] ${cmd === "stop" ? "stopped: no new payments" : "resumed"}`);
      for (const l of reschedule(now)) print(`scheduler: ${l}`);
      return;
    }
    case "notify-test": {
      const s = readSecrets(home);
      if (s.telegramToken && !s.telegramChatId) {
        const chat = await findTelegramChat(s.telegramToken);
        if (!chat) print("Telegram: send /start to your bot first, then run this again.");
        else {
          const path = join(home, ".env");
          writeFileSync(path, readFileSync(path, "utf8").replace(new RegExp(`^\\s*${ENV_KEYS.telegramChatId}\\s*=.*$`, "m"), `${ENV_KEYS.telegramChatId}=${chat}`), { mode: 0o600 });
          s.telegramChatId = chat;
          print("Telegram: found your chat and saved it.");
        }
      }
      const n = makeNotifier(s);
      if (!n.channels.length) return print("Neither Telegram nor Discord is filled in the settings file yet.");
      let addr: Hex | null = null;
      try {
        addr = wallet().address as Hex;
      } catch {
        // no key yet, the card says so
      }
      await n.send({ kind: "test", wallet: addr });
      return print(`sent a test message to: ${n.channels.join(", ")}`);
    }
    case "schedule": {
      if (arg === "install" || arg === "remove") {
        writeLauncher(home, process.argv[1]);
        for (const l of arg === "install" ? applySchedule(scheduleFor(loadSeries(home), now), home) : applySchedule(null, home)) print(l);
      } else for (const l of showSchedule()) print(l);
      return;
    }
    default:
      print(HELP);
  }
}

main().catch((e) => {
  process.stderr.write(`bookkeeper: ${(e as Error).message}\n`);
  process.exitCode = 1;
});
