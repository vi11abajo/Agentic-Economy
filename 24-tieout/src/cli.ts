#!/usr/bin/env node
// tieout: a plain-language activity report for a Pharos wallet over a period, with the books checked against the chain.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAddress, isAddress } from "viem";
import { EXPLORER_TX, viemChain } from "./chain.js";
import { booksCsv, fingerprint, transactionsCsv } from "./csv.js";
import { socialscan, type Hex } from "./explorer.js";
import { CATEGORY_TITLE } from "./ledger.js";
import { markdown } from "./markdown.js";
import { pdf } from "./pdf.js";
import { readPeriod } from "./period.js";
import { buildReport } from "./report.js";
import { ties } from "./tieout.js";
import { amountOf, summary } from "./words.js";

const HELP = `tieout: activity report for a Pharos wallet over a period, checked against the chain
  tieout report <address> --from <date> --to <date> [options]
    --from, --to     2026-11-01 (the whole day) or 2026-11-01T09:30 ; both ends included
    --tz             zone the dates are in: UTC (default) or an offset like +03:00
    --out <dir>      where the files go (default ./tieout-reports)
    --format         any of md,csv,pdf (default all three)
  Read-only: no key, no wallet access, nothing is signed or sent.`;

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const print = (s = "") => process.stdout.write(s + "\n");
const fail = (s: string): never => {
  process.stderr.write(s + "\n");
  process.exit(1);
};

async function main() {
  const from = flag("--from");
  const to = flag("--to");
  const tz = flag("--tz") ?? "UTC";
  const outDir = resolve(flag("--out") ?? "tieout-reports");
  const formats = new Set((flag("--format") ?? "md,csv,pdf").split(",").map((s) => s.trim().toLowerCase()));
  const [cmd, who] = argv;
  if (cmd !== "report") return print(HELP);
  if (!who || !isAddress(who, { strict: false })) fail(`need a wallet address (0x + 40 hex), got "${who ?? ""}"`);
  if (!from || !to) fail("need both --from and --to, e.g. --from 2026-11-01 --to 2026-11-10");
  for (const f of formats) if (!["md", "csv", "pdf"].includes(f)) fail(`unknown format "${f}": use md, csv or pdf`);

  const wallet = getAddress(who) as Hex;
  const period = readPeriod(from!, to!, tz);
  const report = await buildReport(viemChain(), socialscan(), wallet, period, (s) => process.stderr.write(`... ${s}\n`));
  const now = new Date();

  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `tieout-${wallet.slice(2, 8).toLowerCase()}-${from!.slice(0, 10)}-to-${to!.slice(0, 10)}`);
  const written: string[] = [];
  const save = (path: string, body: string | Buffer) => {
    writeFileSync(path, body);
    written.push(path);
  };
  if (formats.has("md")) save(`${base}.md`, markdown(report, now));
  if (formats.has("csv")) {
    save(`${base}.csv`, transactionsCsv(report));
    save(`${base}-books.csv`, booksCsv(report));
  }
  if (formats.has("pdf")) save(`${base}.pdf`, pdf(report, now));

  // What the agent reads back to the user: the summary, the tie-out, the totals and what stands out.
  print("SUMMARY");
  for (const p of summary(report)) print(p);
  print();
  print("DOES IT ADD UP (opening + in - out - gas = closing on chain)");
  for (const l of report.books) {
    const label = report.assets.get(l.asset)?.label ?? l.asset;
    const verdict = l.gap === null ? "can't check" : ties(l) ? "ties" : `OFF by ${amountOf(report, l.asset, l.gap)}`;
    print(`  ${label}: ${amountOf(report, l.asset, l.opening)} -> ${amountOf(report, l.asset, l.closing)}  ${verdict}`);
  }
  print();
  print("TOTALS BY CATEGORY");
  for (const t of report.totals) {
    if (!t.count) continue;
    const moved = [...t.moved].map(([a, m]) => [m.in ? `in ${amountOf(report, a, m.in)}` : "", m.out ? `out ${amountOf(report, a, m.out)}` : ""].filter(Boolean).join(", ")).join("; ");
    print(`  ${CATEGORY_TITLE[t.category]}: ${t.count}${moved ? `  (${moved})` : ""}`);
  }
  print();
  print("WORTH A SECOND LOOK");
  if (!report.notables.length) print("  nothing stood out");
  for (const n of report.notables) print(`  - ${n.why}${n.hash ? `  ${EXPLORER_TX}${n.hash}` : ""}`);
  print();
  print(`FILES (fingerprint ${fingerprint(report)})`);
  for (const w of written) print(`  ${w}`);
}

main().catch((e) => fail(`tieout: ${e instanceof Error ? e.message : String(e)}`));
