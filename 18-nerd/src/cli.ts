#!/usr/bin/env node
import { parseArgs } from "node:util";
import { headBlock } from "./chain.js";
import { readTheDocs, type Brief } from "./docs.js";
import { CHAIN_MCP_URL, DOCS_MCP_URL, McpLine, type CallNote } from "./mcp.js";
import { docsFirstProblem, loadBrief, loadSheet, nerdHome, saveBrief, saveSheet } from "./store.js";
import {
  NothingToCall,
  anyFunction,
  cctpSend,
  firstCallInBlocks,
  targetForTx,
  x402Decimals,
  x402Domain,
  type Reading,
  type Sheet,
  type Target,
} from "./subjects.js";

const HELP = `nerd: reads the Pharos docs first, then calls the same function on chain, then holds one up against the other.

  nerd docs  <target>   Docs MCP only: search, open the pages, keep the lines that talk about the target
  nerd call  <target>   Chain MCP only: eth_call (simulation, nothing is ever sent). Needs a fresh 'docs' first
  nerd read  <target>   puts the two side by side: MATCH / DIFFERENT / DOCS SILENT / CHAIN SAYS NO, with quotes
  nerd first [--max-blocks 300]   the first function call in the latest blocks, newest first

targets
  x402-domain                      USDC DOMAIN_SEPARATOR() against the EIP-712 settings the x402 docs sign with
  x402-decimals                    USDC decimals() against the scale and prices in the x402 docs
  cctp-send --dest N --from 0x.. [--recipient 0x..] [--body text] [--min-finality N] [--caller 0x..]
                                   CCTP MessageTransmitterV2.sendMessage, simulated
  --to 0x.. --sig "name(type,...)" [--returns "type,..."] [--args a,b]
                                   any function on any contract
  --tx 0x<hash>                    the function a real transaction called, replayed as its sender

  --json   machine-readable output        data folder: NERD_HOME (now ${nerdHome()})
exit codes: 0 done, 1 network or server trouble, 2 bad input or the docs were not read first`;

type Flags = Record<string, string | boolean | undefined>;

function exitWith(code: number, message: string): never {
  console.error(`nerd: ${message}`);
  process.exit(code);
}

function needString(flags: Flags, name: string): string {
  const v = flags[name];
  if (typeof v !== "string" || v === "") exitWith(2, `--${name} is required for this target`);
  return v;
}

async function pickTarget(name: string | undefined, flags: Flags, chain: McpLine): Promise<Target> {
  if (typeof flags.tx === "string") {
    if (!/^0x[0-9a-fA-F]{64}$/.test(flags.tx)) exitWith(2, "--tx must be a 32-byte transaction hash");
    return targetForTx(chain, flags.tx);
  }
  if (typeof flags.to === "string") {
    return anyFunction({
      to: flags.to,
      signature: needString(flags, "sig"),
      returns: typeof flags.returns === "string" ? flags.returns : undefined,
      args: typeof flags.args === "string" && flags.args !== "" ? flags.args.split(",").map((a) => a.trim()) : [],
    });
  }
  switch (name) {
    case "x402-domain":
      return x402Domain();
    case "x402-decimals":
      return x402Decimals();
    case "cctp-send": {
      const from = needString(flags, "from");
      const dest = Number(needString(flags, "dest"));
      if (!Number.isInteger(dest) || dest < 0) exitWith(2, "--dest must be a whole domain number");
      return cctpSend({
        destinationDomain: dest,
        from,
        recipient: typeof flags.recipient === "string" ? flags.recipient : from,
        destinationCaller: typeof flags.caller === "string" ? flags.caller : undefined,
        minFinality: typeof flags["min-finality"] === "string" ? Number(flags["min-finality"]) : undefined,
        body: typeof flags.body === "string" ? flags.body : "hello from nerd",
      });
    }
    default:
      exitWith(2, name ? `unknown target "${name}" (see nerd --help)` : "say what to look at: a target name, --to/--sig or --tx");
  }
}

function traceLine(note: CallNote): void {
  const args = Object.entries(note.args)
    .map(([k, v]) => `${k}=${typeof v === "string" ? (v.length > 70 ? `${v.slice(0, 66)}...` : v) : JSON.stringify(v).slice(0, 90)}`)
    .join(" ");
  console.log(`  · ${note.server === "docs" ? "Docs MCP " : "Chain MCP"} ${note.tool} ${args}  ${note.failed ? "-> error " : ""}${note.ms} ms`);
}

/** Docs tables pad cells with long runs of spaces; squeeze them on screen (the saved brief keeps them). */
function squeezed(text: string): string {
  return text.replace(/ {2,}/g, " ");
}

function sourceNumber(brief: Brief, url: string): number {
  return brief.pages.findIndex((p) => p.url === url) + 1;
}

function printBrief(brief: Brief): void {
  console.log(`\nDocs MCP on: ${brief.subject}`);
  console.log(`searched: ${brief.searched.map((s) => `"${s}"`).join(", ")}`);
  if (brief.pages.length === 0) {
    console.log("No docs page found talks about it. Nothing below comes from the docs.");
    return;
  }
  console.log("sources:");
  brief.pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.title}  ${p.url}`));
  console.log("what they say (word for word, table padding squeezed):");
  for (const q of brief.quotes) console.log(`  [${sourceNumber(brief, q.url)}] ${squeezed(q.text)}`);
}

function printSheet(sheet: Sheet): void {
  console.log(`\nChain MCP on: ${sheet.subject} (state at block ${sheet.block})`);
  for (const shot of sheet.shots) {
    const from = shot.ask.from ? ` from ${shot.ask.from}` : "";
    console.log(`  ${shot.label} on ${shot.ask.to}${from}: ${shot.ok ? shot.result : `reverted${shot.reason ? `: ${shot.reason}` : ""}`}`);
  }
  if (sheet.gas) console.log(`  estimate_gas: ${sheet.gas.gas ?? `none (${sheet.gas.reason})`}`);
  if (sheet.log) console.log(`  newest real event found: block ${Number(sheet.log.blockNumber)}, tx ${sheet.log.transactionHash}`);
  console.log("  (eth_call only: nothing was signed or sent)");
}

function printReading(brief: Brief, reading: Reading): void {
  console.log(`\nReading: ${reading.subject}`);
  for (const v of reading.verdicts) {
    console.log(`  ${v.mark.padEnd(13)} ${v.topic}`);
    if (v.docs) console.log(`                docs [${sourceNumber(brief, v.docs.url)}]: ${squeezed(v.docs.text)}`);
    if (v.docsValue !== undefined) console.log(`                docs value:  ${v.docsValue}`);
    if (v.chainValue !== undefined) console.log(`                chain value: ${v.chainValue}`);
  }
  if (reading.plainly.length > 0) {
    console.log("in plain words:");
    for (const line of reading.plainly) console.log(`  ${line}`);
  }
  console.log("sources:");
  if (brief.pages.length === 0) console.log("  none: the docs had nothing on this");
  brief.pages.forEach((p, i) => console.log(`  [${i + 1}] ${p.url}`));
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      tx: { type: "string" },
      to: { type: "string" },
      sig: { type: "string" },
      returns: { type: "string" },
      args: { type: "string" },
      dest: { type: "string" },
      from: { type: "string" },
      recipient: { type: "string" },
      caller: { type: "string" },
      body: { type: "string" },
      "min-finality": { type: "string" },
      "max-blocks": { type: "string" },
    },
  });
  const [command, name] = positionals;
  if (values.help || !command) {
    console.log(HELP);
    return;
  }
  const json = Boolean(values.json);
  const docs = new McpLine("docs", DOCS_MCP_URL);
  const chain = new McpLine("chain", CHAIN_MCP_URL);
  if (!json) docs.onCall = chain.onCall = traceLine;

  try {
    if (command === "first") {
      const maxBlocks = Number(values["max-blocks"] ?? 300);
      const head = await headBlock(chain);
      const seen = await firstCallInBlocks(chain, head, maxBlocks);
      if (!seen) exitWith(2, `no transaction with calldata in the last ${maxBlocks} blocks`);
      const { tx } = seen;
      if (json) console.log(JSON.stringify({ head, ...seen }, null, 2));
      else {
        console.log(`\nFirst function call walking back from block ${head}: block ${Number(tx.blockNumber)}`);
        console.log(`  looked at ${seen.looked} blocks (${seen.empty} empty, ${seen.noCalldata} plain transfers skipped)`);
        console.log(`  tx ${tx.hash}\n  from ${tx.from}\n  to ${tx.to}\n  selector ${tx.input.slice(0, 10)} (${(tx.input.length - 10) / 2} bytes of arguments)`);
        console.log(`next: nerd docs --tx ${tx.hash}`);
      }
      return;
    }

    const target = await pickTarget(name, values, chain);
    if (command === "docs") {
      const brief = await readTheDocs(docs, target.plan());
      saveBrief(brief);
      if (json) console.log(JSON.stringify({ ...brief, pages: brief.pages.map((p) => ({ url: p.url, title: p.title })) }, null, 2));
      else printBrief(brief);
    } else if (command === "call") {
      const brief = loadBrief(target.key);
      const problem = docsFirstProblem(brief);
      if (problem || !brief) exitWith(2, problem ?? "no docs brief");
      const head = await headBlock(chain);
      const sheet = await target.fire(chain, brief, head);
      saveSheet(sheet);
      if (json) console.log(JSON.stringify(sheet, null, 2));
      else printSheet(sheet);
    } else if (command === "read") {
      const brief = loadBrief(target.key);
      const sheet = loadSheet(target.key);
      if (!brief) exitWith(2, "nothing read from the docs for this target yet: run `nerd docs` first");
      if (!sheet || sheet.madeAt < brief.madeAt) exitWith(2, "no chain call after the latest docs read: run `nerd call` first");
      const reading = target.judge(brief, sheet);
      if (json) console.log(JSON.stringify(reading, null, 2));
      else printReading(brief, reading);
    } else {
      exitWith(2, `unknown command "${command}" (docs, call, read, first)`);
    }
  } catch (err) {
    if (err instanceof NothingToCall) exitWith(2, err.message);
    exitWith(1, (err as Error).message);
  } finally {
    await Promise.allSettled([docs.close(), chain.close()]);
  }
}

await main();
