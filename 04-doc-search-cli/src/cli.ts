#!/usr/bin/env node
// rtfm: ask the Pharos docs from the terminal (Developer Docs MCP), get a short answer with sources,
// and optionally check the answer's facts on mainnet (Pharos Chain MCP).
import { PharosMcp } from "@agentic-economy/pharos-mcp";
import { concise, isNoAnswer, parseAnswer, parseSearch, plain, firstSentence, type Source } from "./answer.js";
import { DocsMcp } from "./docs.js";
import { extractClaims, hasClaims, verifyClaims, MAINNET_CHAIN_ID, type Check } from "./verify.js";
import { createInterface } from "node:readline/promises";
import { HELP, parseArgs, type AskOptions } from "./args.js";
import { displayPath, loadSettings, saveSettings, settingsPath } from "./settings.js";
import { ASKING, VERIFYING, startSpinner, type Spinner } from "./spinner.js";

let color = process.stdout.isTTY ?? false;
const C = { cobalt: "\x1b[38;2;30;43;250m", muted: "\x1b[38;2;107;107;107m", green: "\x1b[38;2;5;150;105m", red: "\x1b[38;2;220;38;38m", amber: "\x1b[38;2;180;83;9m", bold: "\x1b[1m", reset: "\x1b[0m" };
const paint = (c: keyof typeof C, s: string) => (color ? `${C[c]}${s}${C.reset}` : s);

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes("--color")) color = true;
  if (argv.includes("--no-color")) color = false;
  const cmd = parseArgs(argv.filter((a) => a !== "--color" && a !== "--no-color"));

  if (cmd.kind === "help") {
    console.log(HELP);
    return cmd.code;
  }
  if ((cmd.kind === "ask" || cmd.kind === "settings") && cmd.setVerify !== undefined) {
    saveSettings({ ...loadSettings(), verify: cmd.setVerify });
  }
  if (cmd.kind === "settings") {
    const on = loadSettings().verify;
    console.log(`On-chain verify is ${paint("cobalt", paint("bold", on ? "on" : "off"))}${cmd.setVerify !== undefined ? " now" : ""}.`);
    console.log(paint("muted", `Saved in ${displayPath(settingsPath())}. --verify or --no-verify change it for one question.`));
    return 0;
  }

  let options: AskOptions | undefined;
  if (cmd.kind === "ask") options = cmd.options;
  if (cmd.kind === "prompt") {
    // Bare `rtfm`: read one question as typed, so apostrophes and ? need no quoting. Not a chat: one question, then exit.
    if (!process.stdin.isTTY) {
      console.log(HELP);
      return 1;
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const question = (await rl.question(paint("cobalt", "Ask: "))).trim();
    rl.close();
    if (!question) return 1;
    options = { ...cmd.options, question };
  }

  const spinner = startSpinner(ASKING);
  const docs = new DocsMcp();
  try {
    await docs.connect();
    if (cmd.kind === "search") return await search(docs, cmd.words, spinner);
    if (cmd.kind === "page") return await page(docs, cmd.url, spinner);
    return await ask(docs, options!, options!.verify ?? loadSettings().verify, spinner);
  } finally {
    spinner.stop();
    await docs.close();
  }
}

async function ask(docs: DocsMcp, opt: AskOptions, verify: boolean, spinner: Spinner): Promise<number> {
  let answer: ReturnType<typeof parseAnswer>;
  let noAnswer: boolean;
  let pages: Source[];
  let verified: { block: number; checks: Check[] } | undefined;
  try {
    answer = parseAnswer(await docs.ask(opt.question));
    noAnswer = isNoAnswer(answer);
    // With no answer, the sources askQuestion lists are just whatever it looked at; a search is more useful.
    pages = noAnswer ? parseSearch(await docs.search(opt.question)) : answer.sources;
    const claims = extractClaims(answer.body);
    if (verify && !noAnswer && hasClaims(claims)) {
      spinner.phase(VERIFYING);
      const chain = new PharosMcp("rtfm");
      await chain.connect();
      try {
        verified = await verifyClaims(chain, claims);
      } finally {
        await chain.close();
      }
    }
  } finally {
    spinner.stop();
  }
  const text = plain(answer.body);
  const claims = extractClaims(answer.body);

  if (opt.json) {
    console.log(JSON.stringify({ question: opt.question, answered: !noAnswer, answer: noAnswer ? null : text,
      docsSaid: noAnswer ? firstSentence(text) : undefined, sources: pages.slice(0, opt.sources), claims, verified }, null, 2));
    return noAnswer ? 2 : 0;
  }

  if (noAnswer) {
    console.log(paint("amber", paint("bold", "No answer in the Pharos docs for this.")));
    console.log(paint("muted", `Docs MCP: "${firstSentence(text)}"`));
    printSources("Closest pages", pages, opt.sources);
    if (verify) console.log(paint("muted", "\nNothing to verify on-chain: there is no answer to check."));
    return 2;
  }

  const shown = opt.full ? { text, trimmed: false } : concise(text);
  console.log(wrap(shown.text));
  if (shown.trimmed) console.log(paint("muted", "… (shortened, use --full for the whole answer)"));
  printSources("Sources", pages, opt.sources);
  if (verify) printChecks(verified);
  return 0;
}

async function search(docs: DocsMcp, words: string, spinner: Spinner): Promise<number> {
  const pages = parseSearch(await docs.search(words).finally(() => spinner.stop()));
  if (!pages.length) {
    console.log(paint("amber", "No matching pages."));
    return 2;
  }
  printSources("Pages", pages, 10);
  return 0;
}

async function page(docs: DocsMcp, url: string, spinner: Spinner): Promise<number> {
  console.log(wrap(plain(await docs.page(url).finally(() => spinner.stop()))));
  return 0;
}

function printSources(title: string, sources: Source[], n: number): void {
  if (!sources.length) return;
  console.log(`\n${paint("cobalt", paint("bold", title))}`);
  sources.slice(0, n).forEach((s, i) => console.log(`  ${i + 1}. ${s.title}  ${paint("cobalt", s.url)}`));
}

function printChecks(v: { block: number; checks: Check[] } | undefined): void {
  if (!v || !v.checks.length) {
    console.log(paint("muted", "\nNothing to verify on-chain: no addresses, chain IDs or block limits in this answer."));
    return;
  }
  console.log(`\n${paint("cobalt", paint("bold", "Checked on Pharos mainnet"))} ${paint("muted", `(chain ${MAINNET_CHAIN_ID}, block ${v.block.toLocaleString("en-US")}, via Pharos Chain MCP)`)}`);
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

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
