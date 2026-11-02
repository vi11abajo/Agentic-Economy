#!/usr/bin/env node
// whatswrong <tx hash>: why did this Pharos transaction fail, and would the fix actually work?
// Read-only: it never signs or sends anything. Exit codes: 0 explained, 1 couldn't investigate, 2 bad input.
import { pathToFileURL } from "node:url";
import { performAutopsy } from "./autopsy.js";
import { PharosMcp } from "./mcp.js";
import { proveTheFix } from "./remedy.js";
import { asJson, factSheet } from "./report.js";
import { onChainWitness } from "./witness.js";

const HELP = `whatswrong: explains why a transaction on Pharos mainnet failed, and checks the fix by replaying it.

  whatswrong <tx hash>          the fact sheet: what broke, where, why, and whether the fix goes through
  whatswrong <tx hash> --json   the same, as JSON
  whatswrong <tx hash> --quick  skip the fix check (just the diagnosis)

Reads through Pharos Chain MCP (mcp.pharos.xyz); call traces and patched replays through rpc.pharos.xyz.`;

export async function investigate(argv: string[], print: (s: string) => void = console.log): Promise<number> {
  const hash = argv.find((a) => !a.startsWith("--"));
  if (!hash || argv.includes("--help")) {
    print(HELP);
    return hash ? 0 : 2;
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    print(`that doesn't look like a transaction hash: ${hash}`);
    return 2;
  }
  const mcp = new PharosMcp("whatswrong");
  await mcp.connect();
  try {
    const witness = onChainWitness(mcp);
    const autopsy = await performAutopsy(witness, hash);
    const fix = autopsy.kind === "not_failed" || argv.includes("--quick") ? undefined : await proveTheFix(witness, autopsy);
    print(argv.includes("--json") ? asJson(autopsy, fix) : factSheet(autopsy, fix));
    return 0;
  } finally {
    await mcp.close().catch(() => {});
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("whatswrong.mjs")) {
  investigate(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((e) => {
      console.error(`couldn't investigate: ${(e as Error).message}`);
      process.exit(1);
    });
}
