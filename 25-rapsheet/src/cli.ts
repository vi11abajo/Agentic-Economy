#!/usr/bin/env node
// rapsheet <address> [--me <your wallet>] [--watchlist list.json] [--window blocks] [--json out.json] [--md out.md]
// Exit code: 0 LOW, 1 MEDIUM, 2 HIGH, 3 couldn't check. So another agent can put it in front of a send.
import { readFileSync, writeFileSync } from "node:fs";
import { isAddress } from "viem";
import { card, markdown } from "./card.js";
import { viemChain } from "./chain.js";
import { socialscan, type Hex } from "./explorer.js";
import { rapsheet, type WatchEntry } from "./rapsheet.js";
import { exitCode } from "./verdict.js";

const HELP = `rapsheet: pull an address's whole record on Pharos mainnet before you pay, approve or call it.

  rapsheet <address> [--me <your wallet>] [--watchlist list.json] [--window blocks] [--json out.json] [--md out.md]

  --me         your own wallet: adds first contact, look-alikes of addresses you paid, dust sent to you
  --watchlist  JSON list of {"address","reason","source"} you already consider bad
  --window     recent blocks to scan for approvals given to a wallet (default 100000, about a day)
  --json/--md  also write the report to a file

Exit code: 0 LOW, 1 MEDIUM, 2 HIGH, 3 could not check. Read-only: no keys, nothing is signed or sent.`;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<number> {
  const target = process.argv[2];
  if (!target || target === "--help" || target === "-h") {
    console.log(HELP);
    return target ? 0 : 3;
  }
  if (!isAddress(target, { strict: false })) {
    console.error(`"${target}" is not an address (0x followed by 40 hex characters).`);
    return 3;
  }
  const me = arg("--me");
  if (me && !isAddress(me, { strict: false })) {
    console.error(`--me "${me}" is not an address.`);
    return 3;
  }
  const listFile = arg("--watchlist");
  const watchlist: WatchEntry[] = listFile ? JSON.parse(readFileSync(listFile, "utf8")) : [];

  const window = arg("--window") ? Number(arg("--window")) : undefined;
  if (window !== undefined && !(window > 0)) {
    console.error("--window needs a number of blocks.");
    return 3;
  }
  const report = await rapsheet(target as Hex, viemChain(), socialscan(), { me: me as Hex | undefined, watchlist, window });
  console.log(card(report));
  const json = arg("--json");
  if (json) writeFileSync(json, JSON.stringify(report, null, 2));
  const md = arg("--md");
  if (md) writeFileSync(md, markdown(report));
  return exitCode(report.verdict.risk);
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`rapsheet couldn't finish: ${(e as Error)?.message ?? e}`);
    process.exit(3);
  },
);
