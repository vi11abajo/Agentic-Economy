#!/usr/bin/env node
// knock on the command line. Exit codes are for the agent driving it: 0 a plan is ready, 2 knock needs an answer
// first, 3 knock stopped the payment, 1 something broke.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress, isAddress } from "viem";
import { accountFacts, describe } from "./account.js";
import { ETHEREUM_RPC, RpcChain } from "./chain.js";
import { resolveName } from "./names.js";
import { parsePayment } from "./parse.js";
import { buildPlan } from "./plan.js";
import { renderSummary, renderVerdicts } from "./render.js";
import { serveSigning } from "./sign.js";

const HELP = `knock: prepare a payment on Pharos from a sentence, after knocking on the recipient's address.

  knock pay "<what to pay>" --from <your 0x address> [--answer "<text>"]... [--out <file>] [--json]
      Reads the sentence, asks if anything is unclear (exit 2), checks recipient, token, balance and what the
      money would do on arrival, then prints a summary followed by the unsigned transaction (exit 0) or stops
      (exit 3). The plan is saved to knock-plan.json (or --out) for "knock sign".
  knock who <name.eth | 0x address>
      Only the recipient check: what the name resolves to, and what lives at the address on Ethereum and Pharos.
  knock sign <plan file> [--port 8643]
      Opens a page on 127.0.0.1 that hands the payment to your own browser wallet, after checking it again.

knock never signs or sends anything. It has no key.
Reads Pharos through ${process.env.PHAROS_RPC_URL ?? "https://rpc.pharos.xyz"} (PHAROS_RPC_URL) and Ethereum, for .eth names only,
through ${ETHEREUM_RPC} (ETHEREUM_RPC_URL).`;

function flags(argv: string[]) {
  const pos: string[] = [];
  const answers: string[] = [];
  const one: Record<string, string> = {};
  const bools = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "--help" || a === "-h") bools.add(a);
    else if (a === "--answer") answers.push(argv[++i] ?? "");
    else if (a.startsWith("--")) one[a.slice(2)] = argv[++i] ?? "";
    else pos.push(a);
  }
  return { pos, answers, one, bools };
}

async function pay(text: string, from: string | undefined, answers: string[], out: string, json: boolean): Promise<number> {
  console.log(`you: ${text}`);
  for (const a of answers) console.log(`you (answer): ${a}`);
  const parsed = parsePayment(text, answers);
  const questions = "questions" in parsed ? [...parsed.questions] : [];
  if (!from) questions.push({ field: "recipient", ask: "Which address are you paying from? knock needs your public 0x address (never a key) to check your balance." });
  if (questions.length || !("intent" in parsed)) {
    console.log("\nI need to ask before I prepare anything:");
    for (const q of questions) console.log(`  ? ${q.ask}`);
    console.log('\nAnswer with: --answer "<your answer>" (and --from <address> if it was missing)');
    return 2;
  }
  const i = parsed.intent;
  console.log(`understood: ${i.amount} ${i.token} to ${i.recipientKind === "self" ? "yourself" : i.recipient}\n`);

  const built = await buildPlan(new RpcChain(), new RpcChain(ETHEREUM_RPC), i, from!);
  console.log(renderSummary(built));
  if (!built.plan) return 3;

  const file = resolve(out);
  writeFileSync(file, JSON.stringify(built.plan, null, 2));
  console.log(`\nunsigned transaction (EIP-1559, chain 1672):\n${JSON.stringify(built.plan.tx, null, 2)}`);
  console.log(`\nwallet signing request:\n${JSON.stringify(built.plan.sendRequest, null, 2)}`);
  if (built.plan.byAuthorization) console.log(`\nor, pay by signature (eth_signTypedData_v4):\n${JSON.stringify(built.plan.byAuthorization.typedData, null, 2)}`);
  console.log(`\nsaved to ${file}. To sign it in your own wallet: knock sign ${out}`);
  if (json) console.log(JSON.stringify({ plan: built.plan }));
  return 0;
}

async function who(target: string): Promise<number> {
  const ph = new RpcChain();
  const l1 = new RpcChain(ETHEREUM_RPC);
  if (/\.eth$/i.test(target)) {
    const r = await resolveName(target.toLowerCase(), l1, ph);
    console.log(renderVerdicts([r.verdict]));
    return r.verdict.level === "BLOCK" ? 3 : 0;
  }
  if (!isAddress(target, { strict: false })) {
    console.log(`"${target}" is neither an .eth name nor an address.`);
    return 2;
  }
  const [a, b] = await Promise.all([accountFacts(ph, target), accountFacts(l1, target)]);
  console.log(`${getAddress(target)}\n  on Pharos    ${describe(a)}\n  on Ethereum  ${describe(b)}`);
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  const f = flags(rest);
  if (!cmd || cmd === "help" || f.bools.has("--help") || f.bools.has("-h")) {
    console.log(HELP);
    return 0;
  }
  if (cmd === "pay") {
    if (!f.pos.length) return console.log('pay needs the sentence in quotes, e.g. knock pay "send 1 USDC to alice.eth" --from 0x...'), 2;
    return pay(f.pos.join(" "), f.one.from, f.answers, f.one.out ?? "knock-plan.json", f.bools.has("--json"));
  }
  if (cmd === "who") {
    if (!f.pos[0]) return console.log("who needs a name or an address."), 2;
    return who(f.pos[0]);
  }
  if (cmd === "sign") {
    if (!f.pos[0]) return console.log("sign needs the plan file that knock pay saved."), 2;
    await serveSigning(f.pos[0], Number(f.one.port ?? 8643));
    return new Promise<number>(() => {}); // the page runs until Ctrl+C
  }
  console.log(`unknown command "${cmd}".\n\n${HELP}`);
  return 2;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`knock broke: ${(e as Error).message}`);
    process.exit(1);
  },
);
