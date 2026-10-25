#!/usr/bin/env node
// pharos-howto: "how do I do X on Pharos?" answered from the Developer Docs MCP with its sources, turned into
// a plan whose every step cites a docs page, carried out through the Chain MCP (anything that moves funds is
// prepared first and only signed after a yes), and checked on chain against the plan.
// Exit codes: 0 done, 1 error, 2 bad input or setup missing, 3 the docs don't cover it, 4 the result doesn't
// match the plan.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, getAddress, isAddress, parseEther, type Account, type Hex } from "viem";
import { concise, isNoAnswer, parseAnswer, parseSearch, plain, type Source } from "./answer.js";
import { ChainMcp, type Chain } from "./chain.js";
import { DocsMcp, type DocsSource } from "./docs.js";
import { hasSource, validateSteps, type Plan, type Step, type StepResult } from "./plan.js";
import { DEFAULTS, EXPLORER, receiptChecks, runPlan, type Settings } from "./run.js";
import { displayPath, homeDir, journal, listPlans, loadPlan, loadSettings, nextPlanId, saveSettings, savePlan, signer } from "./store.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const HELP = `pharos-howto: "how do I do X on Pharos?" from the docs, then done on chain and checked.

  howto ask "<how do I ...>"          ask the Docs MCP; starts a plan with the answer and its sources
  howto search "<query>" --plan N     search the docs; the pages found count as sources of plan N
  howto page <docs url> --plan N      read a whole docs page; it counts as a source of plan N
  howto steps N <steps.json | ->      attach the steps to plan N (each one cites a source of the plan); - reads stdin
  howto run N                         do the reads, prepare the transactions; nothing is sent
  howto run N --from <address>        a dry run as that address, when there is no key yet
  howto run N --yes                   the same, then sign with the key in .env, send, and check the result
  howto verify N                      check the last run's transactions again (e.g. one mined late)
  howto show N | howto list           a plan with its runs | all plans
  howto wallet                        the signer's address and PROS balance (the key is never printed)
  howto config [set k=v ...]          gas_buffer_pct, max_fee_multiplier, max_pros_per_tx, receipt_timeout_sec

Data lives in ${displayPath(homeDir())}: plans/, journal.jsonl, config.json, .env (the key, you put it there).`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f = { yes: false, plan: undefined as string | undefined, full: false, from: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") f.yes = true;
    else if (a === "--full") f.full = true;
    else if (a === "--plan") f.plan = argv[++i];
    else if (a === "--from") f.from = argv[++i];
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

export interface Deps {
  home: string;
  docs: () => Promise<DocsSource>;
  chain: () => Promise<Chain>;
  out: (s: string) => void;
}

/** Whether a signing key is there (its address only), so the agent knows if it can send. */
function keyStatus(home: string): string {
  try {
    const a = signer(home);
    return a ? `Signing key: found (signer ${a.address}).` : `Signing key: none yet. The user puts PRIVATE_KEY=0x... into ${displayPath(join(home, ".env"))} themselves.`;
  } catch (e) {
    return `Signing key: ${(e as Error).message}`;
  }
}

const short = (u: string) => u.replace(/^https?:\/\//, "");

function addSources(p: Plan, found: Source[]): Source[] {
  const added = found.filter((s) => !hasSource(p, s.url));
  p.sources.push(...added);
  return added;
}

function needPlan(home: string, id: string | undefined): Plan {
  if (!id) throw new Exit(2, "Which plan? Give its number (howto list shows them).");
  const p = loadPlan(home, id);
  if (!p) throw new Exit(2, `No plan ${id}. howto list shows the plans.`);
  return p;
}

function sourcesBlock(p: Plan): string[] {
  return p.sources.map((s, i) => `  [${i + 1}] ${s.title}  ${short(s.url)}`);
}

function stepLines(r: StepResult, s: Step, sources: Source[]): string[] {
  const src = sources.findIndex((x) => short(x.url).replace(/\.md$/, "") === short(s.source).replace(/\.md$/, ""));
  const out = [`[${r.step}] ${s.title}  (docs: ${src >= 0 ? `[${src + 1}] ` : ""}${short(s.source)})`];
  if (r.prepared) for (const [k, v] of Object.entries(r.prepared)) out.push(`    ${k.padEnd(16)} ${v}`);
  if (r.hash) out.push(`    tx               ${EXPLORER}/tx/${r.hash}`);
  if (r.output) out.push(...r.output.split("\n").map((l) => `    ${l}`));
  for (const c of r.checks) out.push(`    ${c.ok ? "OK  " : "FAIL"} ${c.what}: ${c.got}`);
  if (r.error) out.push(`    ERROR ${r.error}`);
  return out;
}

function outcomeLine(run: Plan["runs"][number]): string {
  if (run.outcome === "success") return "OUTCOME  success: every step done and every check matches the plan";
  if (run.outcome === "prepared") return "OUTCOME  prepared: nothing was sent. After the user says yes: howto run <N> --yes";
  const bad = run.results.flatMap((r) => [...(r.error ? [`step ${r.step}: ${r.error}`] : []), ...r.checks.filter((c) => !c.ok).map((c) => `step ${r.step}: ${c.what} (got ${c.got})`)]);
  return `OUTCOME  failure: ${bad.join("; ")}`;
}

export async function main(argv: string[], deps?: Partial<Deps>): Promise<number> {
  const d: Deps = {
    home: deps?.home ?? homeDir(),
    docs: deps?.docs ?? (() => DocsMcp.open()),
    chain: deps?.chain ?? (() => ChainMcp.open()),
    out: deps?.out ?? ((s) => console.log(s)),
  };
  const [cmd, ...rest] = argv;
  try {
    const { pos, f } = parse(rest);
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
        d.out(HELP);
        d.out(keyStatus(d.home));
        return 0;

      case "ask": {
        const question = pos.join(" ").trim();
        if (!question) throw new Exit(2, 'Ask a question: howto ask "how do I ..."');
        const docs = await d.docs();
        const a = parseAnswer(await docs.ask(question).finally(() => docs.close()));
        const miss = isNoAnswer(a);
        const p: Plan = f.plan
          ? needPlan(d.home, f.plan)
          : { id: nextPlanId(d.home), question, created: new Date().toISOString(), covered: false, answer: "", sources: [], steps: [], runs: [] };
        p.answer = [p.answer, `Q: ${question}\n${a.body}`].filter(Boolean).join("\n\n");
        p.covered = p.covered || !miss;
        addSources(p, a.sources);
        savePlan(d.home, p);
        journal(d.home, { plan: p.id, event: "ask", question, covered: !miss, sources: a.sources.map((s) => s.url) });
        const body = concise(plain(a.body), f.full ? 1000 : 40);
        d.out([`plan ${p.id} · Docs MCP · askQuestion`, "", body.text, ...(body.trimmed ? ["  (shortened, --full for all of it)"] : []), "", "sources:", ...sourcesBlock(p)].join("\n"));
        if (miss) {
          d.out(`\nNOT IN THE DOCS: the Docs MCP has no documented answer to this. Plan ${p.id} can't have steps; say so to the user instead of improvising.`);
          return 3;
        }
        d.out(`\nNext: write the steps (each citing one of the sources above), then: howto steps ${p.id} <steps.json>`);
        return 0;
      }

      case "search":
      case "page": {
        const arg = pos.join(" ").trim();
        if (!arg) throw new Exit(2, cmd === "search" ? 'howto search "<query>" --plan N' : "howto page <docs url> --plan N");
        const p = f.plan ? needPlan(d.home, f.plan) : null;
        const docs = await d.docs();
        const raw = await (cmd === "search" ? docs.search(arg) : docs.page(arg)).finally(() => docs.close());
        const found = cmd === "search" ? parseSearch(raw) : [{ title: (raw.match(/^#\s+(.+)$/m)?.[1] ?? arg).trim(), url: arg }];
        if (cmd === "search") d.out(found.length ? found.map((s, i) => `  ${i + 1}. ${s.title}  ${short(s.url)}`).join("\n") : "no pages found");
        else d.out(concise(plain(raw), f.full ? 100000 : 80).text);
        if (p) {
          const added = addSources(p, found);
          savePlan(d.home, p);
          journal(d.home, { plan: p.id, event: cmd, arg, added: added.map((s) => s.url) });
          d.out(`\n${added.length} new source(s) for plan ${p.id}.`);
        }
        return 0;
      }

      case "steps": {
        const p = needPlan(d.home, pos[0]);
        if (!pos[1]) throw new Exit(2, `howto steps ${p.id} <steps.json>`);
        let parsed: { goal?: string; steps: Step[] } | Step[];
        try {
          parsed = JSON.parse(readFileSync(pos[1] === "-" ? 0 : pos[1], "utf8")); // "-": the steps come on stdin
        } catch (e) {
          throw new Exit(2, `Can't read ${pos[1]}: ${(e as Error).message}`);
        }
        const steps = Array.isArray(parsed) ? parsed : parsed.steps;
        const bad = validateSteps(p, steps);
        if (bad.length) {
          if (!p.covered) {
            d.out(`NOT IN THE DOCS: plan ${p.id} has no documented answer, so it takes no steps.`);
            return 3;
          }
          throw new Exit(2, `Steps not attached:\n${bad.map((b) => `  - ${b}`).join("\n")}`);
        }
        p.steps = steps;
        if (!Array.isArray(parsed) && parsed.goal) p.goal = parsed.goal;
        savePlan(d.home, p);
        journal(d.home, { plan: p.id, event: "steps", steps: steps.length });
        d.out([`plan ${p.id}: ${p.goal ?? p.question}`, ...steps.map((s, i) => `  ${i + 1}. ${s.title}  ${s.tx ? "(transaction, signed only after a yes)" : "(read)"}  docs: ${short(s.source)}`)].join("\n"));
        return 0;
      }

      case "run": {
        const p = needPlan(d.home, pos[0]);
        if (!p.covered) {
          d.out(`NOT IN THE DOCS: plan ${p.id} has no documented answer, nothing to run.`);
          return 3;
        }
        if (!p.steps.length) throw new Exit(2, `Plan ${p.id} has no steps yet: howto steps ${p.id} <steps.json>`);
        let account;
        try {
          account = signer(d.home) ?? undefined;
        } catch (e) {
          throw new Exit(2, (e as Error).message);
        }
        if (f.from && !f.yes) {
          // A dry run as some address, without a key: only to preview what would be prepared.
          if (!isAddress(f.from, { strict: false })) throw new Exit(2, "--from needs an address");
          account = { address: getAddress(f.from) } as Account;
        }
        if (f.yes && !account?.signTransaction) throw new Exit(2, `No key in ${displayPath(join(d.home, ".env"))}. The user puts PRIVATE_KEY=0x... there themselves; never paste it into a chat.`);
        const chain = await d.chain();
        d.out(`plan ${p.id}: ${p.goal ?? p.question}${!p.steps.some((s) => s.tx) ? "  (reads only)" : f.yes ? "  (confirmed: signing and sending)" : "  (dry run: nothing is sent)"}\n`);
        const run = await runPlan(p, chain, { send: f.yes, account, settings: loadSettings(d.home), onStep: (r, s) => d.out(stepLines(r, s, p.sources).join("\n")) }).finally(() => chain.close());
        p.runs.push(run);
        savePlan(d.home, p);
        journal(d.home, { plan: p.id, event: "run", sent: f.yes, outcome: run.outcome, txs: run.results.filter((r) => r.hash).map((r) => r.hash) });
        d.out(`\n${outcomeLine(run).replace("<N>", p.id)}`);
        return run.outcome === "failure" ? 4 : 0;
      }

      case "verify": {
        const p = needPlan(d.home, pos[0]);
        const run = p.runs.at(-1);
        const sent = run?.results.filter((r) => r.hash) ?? [];
        if (!run || !sent.length) throw new Exit(2, `Plan ${p.id} has no sent transactions to verify.`);
        const chain = await d.chain();
        const account = signer(d.home) ?? undefined;
        try {
          for (const r of sent) {
            const step = p.steps[r.step - 1];
            const rc = await chain.receipt(r.hash as Hex);
            r.checks = [];
            r.error = undefined;
            if (!rc) r.error = "still not mined";
            else {
              r.block = rc.block.toString();
              const value = parseEther(step.tx?.value_pros ?? "0");
              for (const e of step.expect ?? []) r.checks.push(...(await receiptChecks(chain, e, rc, value, account?.address)));
            }
            d.out(stepLines(r, step, p.sources).join("\n"));
          }
        } finally {
          await chain.close();
        }
        run.outcome = run.results.some((r) => r.error || r.checks.some((c) => !c.ok)) ? "failure" : "success";
        savePlan(d.home, p);
        journal(d.home, { plan: p.id, event: "verify", outcome: run.outcome });
        d.out(`\n${outcomeLine(run)}`);
        return run.outcome === "failure" ? 4 : 0;
      }

      case "show": {
        const p = needPlan(d.home, pos[0]);
        const lines = [`plan ${p.id}: ${p.question}`, `docs cover it: ${p.covered ? "yes" : "NO"}`, "", "sources:", ...sourcesBlock(p), "", "steps:"];
        p.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s.title}  docs: ${short(s.source)}`));
        for (const run of p.runs) {
          lines.push("", `run ${run.at.replace("T", " ").slice(0, 19)} UTC${run.sent ? ", sent" : ", dry run"}`);
          for (const r of run.results) lines.push(...stepLines(r, p.steps[r.step - 1], p.sources));
          lines.push(outcomeLine(run).replace("<N>", p.id));
        }
        d.out(lines.join("\n"));
        return 0;
      }

      case "list": {
        const ids = listPlans(d.home);
        if (!ids.length) return d.out('No plans yet. Start one with: howto ask "how do I ..."'), 0;
        for (const id of ids) {
          const p = loadPlan(d.home, id)!;
          const last = p.runs.at(-1)?.outcome ?? (p.covered ? (p.steps.length ? "not run" : "no steps") : "not in the docs");
          d.out(`  ${id.padStart(3)}  ${last.padEnd(16)} ${p.question}`);
        }
        return 0;
      }

      case "wallet": {
        const a = signer(d.home);
        if (!a) throw new Exit(2, `No key in ${displayPath(join(d.home, ".env"))}. The user puts PRIVATE_KEY=0x... there themselves.`);
        const chain = await d.chain();
        const bal = await chain.balance(a.address).finally(() => chain.close());
        d.out(`signer ${a.address}\nPROS   ${formatEther(bal)}`);
        return 0;
      }

      case "config": {
        const s = loadSettings(d.home);
        if (pos[0] !== "set") return d.out(JSON.stringify(s, null, 2)), 0;
        for (const kv of pos.slice(1)) {
          const [k, v] = kv.split("=");
          if (!(k in DEFAULTS) || !(Number(v) >= 0)) throw new Exit(2, `Unknown setting or bad value: ${kv}. Settings: ${Object.keys(DEFAULTS).join(", ")}`);
          (s as unknown as Record<string, number>)[k as keyof Settings] = Number(v);
        }
        d.out(`saved to ${displayPath(saveSettings(d.home, s))}\n${JSON.stringify(s, null, 2)}`);
        return 0;
      }

      default:
        throw new Exit(2, `Unknown command "${cmd}". Run howto --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      console.error(e.message);
      return e.code;
    }
    console.error(`howto: ${String((e as Error).message).split("\n")[0]}`);
    return 1;
  }
}

const isMain = process.argv[1] && /(cli\.js|howto(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
