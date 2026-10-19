#!/usr/bin/env node
// foghorn: ask the Pharos docs from the terminal (Developer Docs MCP), get a short answer with sources,
// and optionally check the answer's facts on mainnet (Pharos Chain MCP).
import { PharosMcp } from "@agentic-economy/pharos-mcp";
import { concise, isNoAnswer, parseAnswer, parseSearch, plain, firstSentence, type Source } from "./answer.js";
import { DocsMcp } from "./docs.js";
import { extractClaims, hasClaims, verifyClaims, MAINNET_CHAIN_ID, type Check } from "./verify.js";

const HELP = `Usage:
  foghorn "<question>" [--verify] [--full] [--sources N] [--json]
  foghorn search "<words>"              list matching doc pages
  foghorn page <docs.pharos.xyz URL>     print a whole page

  --verify     check addresses, chain IDs and block limits from the answer on Pharos mainnet (Pharos Chain MCP)
  --full       print the whole answer instead of the first few paragraphs
  --sources N  how many source links to show (default 3)
  --json       machine-readable output

Exit codes: 0 answered, 2 the docs have no answer, 1 error.`;

interface Options {
  question: string;
  verify: boolean;
  full: boolean;
  sources: number;
  json: boolean;
}

let color = process.stdout.isTTY ?? false;
const C = { cobalt: "\x1b[38;2;30;43;250m", muted: "\x1b[38;2;107;107;107m", green: "\x1b[38;2;5;150;105m", red: "\x1b[38;2;220;38;38m", amber: "\x1b[38;2;180;83;9m", bold: "\x1b[1m", reset: "\x1b[0m" };
const paint = (c: keyof typeof C, s: string) => (color ? `${C[c]}${s}${C.reset}` : s);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--color")) color = true;
  if (argv.includes("--no-color")) color = false;
  const args = argv.filter((a) => a !== "--color" && a !== "--no-color");
  if (!args.length || args[0] === "-h" || args[0] === "--help") {
    console.log(HELP);
    return args.length ? 0 : 1;
  }

  const docs = new DocsMcp();
  await docs.connect();
  try {
    if (args[0] === "search") return await search(docs, args.slice(1).join(" "));
    if (args[0] === "page") return await page(docs, args[1]);
    return await ask(docs, parseOptions(args));
  } finally {
    await docs.close();
  }
}

async function ask(docs: DocsMcp, opt: Options): Promise<number> {
  const answer = parseAnswer(await docs.ask(opt.question));
  const noAnswer = isNoAnswer(answer.body);
  const text = plain(answer.body);
  // With no answer, the sources askQuestion lists are just whatever it looked at; a search is more useful.
  const pages = noAnswer ? parseSearch(await docs.search(opt.question)) : answer.sources;
  const claims = extractClaims(answer.body);
  let verified: { block: number; checks: Check[] } | undefined;
  if (opt.verify && !noAnswer && hasClaims(claims)) {
    const chain = new PharosMcp("foghorn");
    await chain.connect();
    try {
      verified = await verifyClaims(chain, claims);
    } finally {
      await chain.close();
    }
  }

  if (opt.json) {
    console.log(JSON.stringify({ question: opt.question, answered: !noAnswer, answer: noAnswer ? null : text,
      docsSaid: noAnswer ? firstSentence(text) : undefined, sources: pages.slice(0, opt.sources), claims, verified }, null, 2));
    return noAnswer ? 2 : 0;
  }

  if (noAnswer) {
    console.log(paint("amber", paint("bold", "No answer in the Pharos docs for this.")));
    console.log(paint("muted", `Docs MCP: "${firstSentence(text)}"`));
    printSources("Closest pages", pages, opt.sources);
    if (opt.verify) console.log(paint("muted", "\nNothing to verify on-chain: there is no answer to check."));
    return 2;
  }

  const shown = opt.full ? { text, trimmed: false } : concise(text);
  console.log(wrap(shown.text));
  if (shown.trimmed) console.log(paint("muted", "… (shortened, use --full for the whole answer)"));
  printSources("Sources", pages, opt.sources);
  if (opt.verify) printChecks(verified);
  return 0;
}

async function search(docs: DocsMcp, words: string): Promise<number> {
  if (!words) throw new Error('Usage: foghorn search "<words>"');
  const pages = parseSearch(await docs.search(words));
  if (!pages.length) {
    console.log(paint("amber", "No matching pages."));
    return 2;
  }
  printSources("Pages", pages, 10);
  return 0;
}

async function page(docs: DocsMcp, url?: string): Promise<number> {
  if (!url || !/^https:\/\/docs\.pharos\.xyz\//.test(url)) throw new Error("Usage: foghorn page https://docs.pharos.xyz/...");
  console.log(wrap(plain(await docs.page(url))));
  return 0;
}

function printSources(title: string, sources: Source[], n: number): void {
  if (!sources.length) return;
  console.log(`\n${paint("bold", title)}`);
  sources.slice(0, n).forEach((s, i) => console.log(`  ${i + 1}. ${s.title}  ${paint("cobalt", s.url)}`));
}

function printChecks(v: { block: number; checks: Check[] } | undefined): void {
  if (!v || !v.checks.length) {
    console.log(paint("muted", "\nNothing to verify on-chain: no addresses, chain IDs or block limits in this answer."));
    return;
  }
  console.log(`\n${paint("bold", "Checked on Pharos mainnet")} ${paint("muted", `(chain ${MAINNET_CHAIN_ID}, block ${v.block.toLocaleString("en-US")}, via Pharos Chain MCP)`)}`);
  for (const c of v.checks) {
    const mark = c.status === "ok" ? paint("green", "✓") : c.status === "wrong" ? paint("red", "✗") : paint("amber", "!");
    console.log(`  ${mark} ${c.claim}: ${paint("muted", c.detail)}`);
  }
}

function wrap(text: string, width = Math.min(process.stdout.columns || 100, 110)): string {
  return text
    .split("\n")
    .map((line) => {
      if (line.length <= width || /^\s{2,}|[{}();=]/.test(line)) return line; // keep code and short lines as they are
      const indent = line.match(/^\s*(?:[-*•]|\d+\.)?\s*/)?.[0] ?? "";
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(" ")) {
        if (cur && (cur + " " + word).length > width) {
          out.push(cur);
          cur = " ".repeat(indent.length) + word;
        } else cur = cur ? `${cur} ${word}` : word;
      }
      return [...out, cur].join("\n");
    })
    .join("\n");
}

function parseOptions(args: string[]): Options {
  const o: Options = { question: "", verify: false, full: false, sources: 3, json: false };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--verify") o.verify = true;
    else if (a === "--full") o.full = true;
    else if (a === "--json") o.json = true;
    else if (a === "--sources") o.sources = Math.max(1, Number(args[++i]) || 3);
    else if (a.startsWith("--")) throw new Error(`Unknown option ${a}\n\n${HELP}`);
    else words.push(a);
  }
  o.question = words.join(" ").trim();
  if (!o.question) throw new Error(HELP);
  return o;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
