#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { isAddress, getAddress, type Hex } from "viem";
import { parseInvoice } from "./parser/index.js";
import { validateInvoice } from "./validator.js";
import { formatPaymentSummary } from "./tx.js";
import { planFromFile } from "./pipeline.js";
import { pharos, checkPaid } from "./chain.js";
import { startSigningServer, startDetached, logFor } from "./sign.js";
import type { PaymentPlan, ValidationFlag } from "./types.js";

const HELP = `remit: turns an invoice into a Pharos payment you can check before you sign

  remit read <invoice>                    what remit lifted off the invoice, and what's wrong with it
  remit plan <invoice> [--from <wallet>]  paper check + chain check + unsigned tx with the reference inside
         [--out plan.json] [--offline] [--allow-expired] [--json]
  remit sign <plan.json> [--port 8645] [--detach]
                                          local page for your browser wallet; rechecks everything first
  remit status <plan.json>                what the signing page saw (for --detach)
  remit paid <tx hash> <plan.json>        does this mined tx pay exactly what the plan says?

Invoices: .json, plain text / markdown, PDF with a text layer, PNG with a payment QR code (EIP-681),
or the text itself in quotes. Tokens: PROS, WPROS, USDC on Pharos mainnet (1672).
Exit codes: 0 fine, 2 flagged (nothing to pay), 1 broken input.`;

const argv = process.argv.slice(2);
const [command, first, second] = argv.filter((a, i) => !a.startsWith("--") && !["--from", "--out", "--port"].includes(argv[i - 1]));
const has = (f: string) => argv.includes(f);
const opt = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);

function printFlags(flags: ValidationFlag[]): void {
  const order = { FATAL: 0, WARNING: 1, INFO: 2 } as const;
  for (const f of [...flags].sort((a, b) => order[a.severity] - order[b.severity])) {
    const mark = f.severity === "FATAL" ? "STOP" : f.severity === "WARNING" ? "WARN" : "note";
    console.log(`  ${mark} ${f.code}${f.field ? ` (${f.field})` : ""}: ${f.message}${f.proof ? `\n       ${f.proof}` : ""}`);
  }
}

async function main(): Promise<number> {
  if (!command || has("--help") || has("-h")) return console.log(HELP), 0;

  if (command === "read") {
    if (!first) return console.error("which invoice? remit read <file>"), 1;
    const raw = parseInvoice(first);
    const paper = validateInvoice(raw, { allowExpired: has("--allow-expired") });
    if (has("--json")) return console.log(JSON.stringify({ raw, ...paper }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2)), paper.ok ? 0 : 2;
    const show = (k: string, v: unknown) => console.log(`  ${k.padEnd(10)} ${v === undefined || v === "" ? "(not on the invoice)" : v}`);
    console.log(`Read as ${raw.format}:`);
    show("reference", raw.reference);
    show("payee", raw.payee);
    show("amount", raw.amount);
    show("currency", raw.currency);
    show("due", raw.dueDate);
    if (raw.chainId !== undefined) show("chain", raw.chainId);
    for (const it of raw.items ?? []) console.log(`    item     ${it.description}: ${it.amount}`);
    console.log(paper.ok ? `\nPaper check: clean${paper.flags.length ? " (with notes)" : ""}` : `\nPaper check: can't pay this as written`);
    printFlags(paper.flags);
    return paper.ok ? 0 : 2;
  }

  if (command === "plan") {
    if (!first) return console.error("which invoice? remit plan <file>"), 1;
    const fromText = opt("--from");
    if (fromText && !isAddress(fromText)) return console.error(`--from ${fromText} isn't a valid address`), 1;
    const outcome = await planFromFile(first, {
      from: fromText ? getAddress(fromText) : undefined,
      allowExpired: has("--allow-expired"),
      client: has("--offline") ? undefined : pharos(),
    });
    if (!outcome.plan) {
      if (has("--json")) console.log(JSON.stringify({ ok: false, flags: outcome.flags }, null, 2));
      else console.log(`No payment prepared for ${first}:`), printFlags(outcome.flags);
      return 2;
    }
    const out = opt("--out");
    if (out) writeFileSync(out, JSON.stringify(outcome.plan, null, 2) + "\n");
    if (has("--json")) console.log(JSON.stringify(outcome.plan, null, 2));
    else console.log(formatPaymentSummary(outcome.plan) + (out ? `\n\nplan saved to ${out}` : ""));
    return 0;
  }

  if (command === "sign") {
    if (!first || !existsSync(first)) return console.error("sign needs a plan file made by `remit plan ... --out plan.json`"), 1;
    const port = Number(opt("--port") ?? 8645);
    if (has("--detach")) {
      const link = await startDetached(process.argv[1], first, port);
      console.log(`signing page is up: ${link}\nopen it, connect your wallet, pay. Then: remit status ${first}`);
      return 0;
    }
    await startSigningServer(first, port, has("--until-mined"));
    return -1; // keep running
  }

  if (command === "status") {
    if (!first) return console.error("remit status <plan.json>"), 1;
    const log = logFor(first);
    if (!existsSync(log)) return console.log("no signing page was started for this plan"), 1;
    const text = readFileSync(log, "utf8").trim();
    console.log(text || "page is up, nothing happened yet");
    return /PAID:/.test(text) ? 0 : 2;
  }

  if (command === "paid") {
    if (!first || !second || !/^0x[0-9a-fA-F]{64}$/.test(first)) return console.error("remit paid <tx hash> <plan.json>"), 1;
    const plan: PaymentPlan = JSON.parse(readFileSync(second, "utf8"));
    const verdict = await checkPaid(pharos(), first as Hex, plan.tx);
    console.log(verdict.ok ? `PAID: ${plan.invoice.reference} is settled by this tx` : `NOT the planned payment`);
    for (const l of verdict.lines) console.log(`  ${l}`);
    return verdict.ok ? 0 : 2;
  }

  console.error(`unknown command '${command}'\n\n${HELP}`);
  return 1;
}

main().then(
  (code) => code >= 0 && process.exit(code),
  (e) => {
    console.error(`remit: ${(e as Error).message.split("\n")[0]}`);
    process.exit(1);
  },
);
