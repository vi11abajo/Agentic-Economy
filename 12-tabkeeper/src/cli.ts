#!/usr/bin/env node
// tabkeeper: an agent buyer for x402 APIs on Pharos. The agent opens a task with a budget and a per-call cap,
// asks for prices, buys only what the task needs, and closes the task with what it spent. Every payment is in
// the journal with its price, what it bought, its tx hash and the running total.
// Exit codes: 0 ok, 1 error, 2 bad input or no key, 3 refused (over the cap or the budget: nothing signed),
// 4 payment failed (see the message: whether money moved is checked on chain).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { formatEther, formatUnits, type Account, type PublicClient } from "viem";
import { buy, findPayment, pick, probe, reconcile, retry, type BuyResult, type Deps } from "./buyer.js";
import { allow, append, currentTask, parseUsdc, payments, readRows, tasks, usdc, type TaskState } from "./ledger.js";
import { EIP3009, NETWORK, txUrl, USDC } from "./pharos.js";
import { account, chainOf, makeClient, signerFor } from "./wallet.js";

export class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

export interface Settings {
  /** Budget and per-call cap of a task started without --budget / --cap, in USDC. */
  default_budget: string;
  default_cap: string;
  /** Sends of one signed payment before giving up (all with the same nonce). */
  max_attempts: number;
  /** Per request, in seconds. */
  timeout_s: number;
  /** Seller base URLs whose /catalog lists what they sell. */
  sellers: string[];
}

export const DEFAULTS: Settings = { default_budget: "0.01", default_cap: "0.005", max_attempts: 4, timeout_s: 60, sellers: ["https://mcp.pharosfdv.xyz/x402"] };

export function homeDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.TABKEEPER_HOME) return env.TABKEEPER_HOME;
  const base = platform === "win32" && env.APPDATA ? env.APPDATA : env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "tabkeeper");
}

const displayPath = (p: string, home = homedir()) => (p.startsWith(home) ? `~${p.slice(home.length)}` : p).replace(/\\/g, "/");

export function loadSettings(home: string): Settings {
  const f = join(home, "config.json");
  return existsSync(f) ? { ...DEFAULTS, ...(JSON.parse(readFileSync(f, "utf8")) as Partial<Settings>) } : { ...DEFAULTS };
}

const HELP = `tabkeeper: pays x402 APIs on Pharos with USDC, inside a budget, and keeps the tab.

  tabkeeper task start "<what the task is>" [--budget USDC] [--cap USDC]   open a task (default ${DEFAULTS.default_budget} / ${DEFAULTS.default_cap})
  tabkeeper task                       the open task: budget, cap, spent, left
  tabkeeper task end [--note "..."]    close it: every payment, refusals, total
  tabkeeper catalog [seller-url]       what the sellers offer and at what price (free)
  tabkeeper price <url>                the price an endpoint asks (its 402), and whether this task allows it. Pays nothing
  tabkeeper buy <url> [--for "what it is for"] [--max USDC]
                                       pay and get the data, if the price fits the cap and the budget
  tabkeeper retry [nonce | tx]         settle payments in flight against the chain; resend one (same payment, no new charge)
  tabkeeper log [--all]                payments of the open task (or all) with price, item, tx and running total
  tabkeeper wallet | config [set k=v ...]

  Over the per-call cap or over what is left of the budget, a call is refused before anything is signed (exit 3).
  A retry resends the same signed payment: the USDC contract accepts its nonce once, so it can't be paid twice.
Data lives in ${displayPath(homeDir())}: config.json, journal.jsonl, .env (PRIVATE_KEY of the paying wallet; you put it there).`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f = { budget: undefined as string | undefined, cap: undefined as string | undefined, max: undefined as string | undefined, for: undefined as string | undefined, note: undefined as string | undefined, all: false, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") pos.unshift("help");
    else if (a === "--budget") f.budget = argv[++i];
    else if (a === "--cap") f.cap = argv[++i];
    else if (a === "--max") f.max = argv[++i];
    else if (a === "--for") f.for = argv[++i];
    else if (a === "--note") f.note = argv[++i];
    else if (a === "--all") f.all = true;
    else if (a === "--json") f.json = true;
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

const amount = (s: string | undefined, what: string) => {
  try {
    const v = parseUsdc(s ?? "");
    if (v <= 0n) throw new Error();
    return v;
  } catch {
    throw new Exit(2, `${what} must be a USDC amount like 0.01 (got ${s ?? "nothing"})`);
  }
};

const url = (s: string | undefined) => {
  try {
    return new URL(s ?? "").toString();
  } catch {
    throw new Exit(2, `Give the endpoint's full URL (got ${s ?? "nothing"})`);
  }
};

const time = (iso: string) => iso.slice(11, 19);
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

function taskLine(t: TaskState): string {
  const left = t.budget - t.spent - t.held;
  return `task "${t.name}": spent ${usdc(t.spent)} of ${usdc(t.budget)} USDC${t.held ? `, ${usdc(t.held)} held in flight` : ""}, ${usdc(left > 0n ? left : 0n)} left, cap ${usdc(t.cap)} per call`;
}

function logLines(list: ReturnType<typeof payments> extends Map<string, infer P> ? P[] : never): string[] {
  const lines = [`  ${"time".padEnd(8)}  ${"price".padStart(8)}  ${"total".padStart(8)}  ${"tx".padEnd(17)}  bought`];
  let run = 0n;
  for (const p of list) {
    if (p.state === "paid") run += p.price;
    const tx = p.state === "paid" ? short(p.tx ?? "?") : p.state === "open" ? "in flight" : "released";
    lines.push(`  ${time(p.at)}  ${usdc(p.price).padStart(8)}  ${(p.state === "paid" ? usdc(run) : "-").padStart(8)}  ${tx.padEnd(17)}  ${p.item}`);
  }
  return lines;
}

function resultLines(r: BuyResult, t: TaskState, what: string): { code: number; lines: string[] } {
  if (r.kind === "free") return { code: r.status < 400 ? 0 : 1, lines: [`FREE  HTTP ${r.status}, no payment asked`, r.body] };
  if (r.kind === "refused") {
    const budget = r.why.startsWith("budget");
    return {
      code: 3,
      lines: [`REFUSED  ${what}: ${r.why}. Nothing was signed.`, budget ? `Budget reached: stop buying for this task and finish with what you have.` : "", taskLine(t)].filter(Boolean),
    };
  }
  if (r.kind === "failed")
    return { code: 4, lines: [`FAILED  ${what}: ${r.why}`, `task total ${usdc(r.total)} USDC${r.nonce ? ` (payment nonce ${r.nonce})` : ""}`] };
  let body = r.body;
  try {
    body = JSON.stringify(JSON.parse(r.body), null, 1);
  } catch {
    /* not JSON */
  }
  return {
    code: 0,
    lines: [
      `BOUGHT  ${what} for ${usdc(r.price)} USDC${r.replayed ? " (seller replayed the answer to an earlier send of this same payment)" : ""}${r.attempts > 1 ? `, after ${r.attempts} sends of the same payment` : ""}`,
      `  tx ${txUrl(r.tx)}`,
      `  ${taskLine(t)}`,
      "--- data ---",
      body,
    ],
  };
}

export interface Ctx {
  home: string;
  out: (s: string) => void;
  client: () => PublicClient;
  account: () => Account | null;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

function deps(c: Ctx, s: Settings, cap: bigint): Deps {
  const acct = c.account();
  if (!acct) throw new Exit(2, `No paying key. Put PRIVATE_KEY=... into ${join(c.home, ".env")} (the wallet needs USDC on Pharos, no PROS).`);
  const sign = signerFor(acct, cap);
  return {
    fetch: c.fetch,
    chain: chainOf(c.client()),
    sign: (required) => sign(required),
    rows: () => readRows(c.home),
    append: (row) => append(c.home, row),
    now: c.now,
    sleep: c.sleep,
    maxAttempts: s.max_attempts,
    timeoutMs: s.timeout_s * 1000,
  };
}

export async function main(argv: string[], c: Ctx): Promise<number> {
  const { pos, f } = parse(argv);
  const s = loadSettings(c.home);
  const stamp = () => new Date(c.now()).toISOString();
  const open = () => {
    const t = currentTask(readRows(c.home));
    if (!t) throw new Exit(2, `No open task. Start one first: tabkeeper task start "<what the task is>" --budget ${s.default_budget} --cap ${s.default_cap}`);
    return t;
  };

  switch (pos[0] ?? "help") {
    case "help":
      c.out(HELP);
      return 0;

    case "task": {
      if (pos[1] === "start") {
        const name = pos.slice(2).join(" ").trim();
        if (!name) throw new Exit(2, 'Say what the task is: tabkeeper task start "check where to put my USDC"');
        const budget = amount(f.budget ?? s.default_budget, "--budget");
        const cap = amount(f.cap ?? s.default_cap, "--cap");
        const prev = currentTask(readRows(c.home));
        if (prev) append(c.home, { event: "task-end", at: stamp(), task: prev.id, note: "closed by a new task" });
        const id = `t${c.now().toString(36)}`;
        append(c.home, { event: "task", at: stamp(), task: id, name, budget: budget.toString(), cap: cap.toString() });
        c.out(`Task started: "${name}". Budget ${usdc(budget)} USDC, at most ${usdc(cap)} USDC per call.`);
        return 0;
      }
      const t = open();
      if (pos[1] === "end") {
        await reconcile(deps(c, s, t.cap));
        const done = tasks(readRows(c.home)).get(t.id)!;
        append(c.home, { event: "task-end", at: stamp(), task: t.id, note: f.note });
        const lines = [`Task closed: "${done.name}"`, ""];
        if (done.payments.length) lines.push(...logLines(done.payments));
        else lines.push("  no payments");
        if (done.refusals.length) {
          lines.push("", "Refused (nothing signed):");
          for (const r of done.refusals) lines.push(`  ${time(r.at)}  ${usdc(r.price).padStart(8)}  ${r.url}: ${r.why}`);
        }
        lines.push("", `Spent ${usdc(done.spent)} of ${usdc(done.budget)} USDC in ${done.payments.filter((p) => p.state === "paid").length} payments${done.held ? `; ${usdc(done.held)} still held by a payment in flight (retry settles it)` : ""}.`);
        c.out(lines.join("\n"));
        return 0;
      }
      if (pos[1]) throw new Exit(2, "task start | task | task end");
      c.out(taskLine(t));
      return 0;
    }

    case "catalog": {
      const sellers = pos[1] ? [pos[1].replace(/\/+$/, "")] : s.sellers;
      for (const base of sellers) {
        const res = await c.fetch(`${base}/catalog`, { signal: AbortSignal.timeout(s.timeout_s * 1000) });
        if (!res.ok) throw new Exit(1, `${base}/catalog answered HTTP ${res.status}`);
        const cat = (await res.json()) as { network: string; items: { seller: string; method: string; path: string; query: string; price: string; description: string }[] };
        const origin = new URL(base).origin;
        const lines = [`${base} (${cat.network}, prices in USDC)`];
        for (const it of cat.items) lines.push(`  ${it.price.padStart(6)}  ${it.method} ${origin}${it.path}${it.query ? `?${it.query}` : ""}`, `          ${it.seller}: ${it.description}`);
        c.out(lines.join("\n"));
      }
      return 0;
    }

    case "price": {
      const u = url(pos[1]);
      const r = await probe({ fetch: c.fetch, timeoutMs: s.timeout_s * 1000 }, u);
      if (r.status !== 402) {
        c.out(`HTTP ${r.status}: no payment asked`);
        return 0;
      }
      const req = pick(r.required!);
      if (!req) {
        c.out(`Asks for payment, but not in Pharos USDC: ${r.required!.accepts.map((a) => `${a.network} ${a.asset} ${a.amount}`).join(", ")}`);
        return 0;
      }
      const price = BigInt(req.amount);
      const t = currentTask(readRows(c.home));
      const d = t ? allow(t, price) : undefined;
      c.out(
        [
          `${usdc(price)} USDC  ${r.required!.resource?.description ?? u}`,
          `  pay to ${req.payTo} on ${req.network}, authorization valid ${req.maxTimeoutSeconds}s`,
          t ? (d!.ok ? `  this task allows it (${taskLine(t)})` : `  this task would refuse it: ${d!.why}`) : "  (no open task)",
        ].join("\n"),
      );
      return 0;
    }

    case "buy": {
      const u = url(pos[1]);
      const t = open();
      const r = await buy(deps(c, s, t.cap), t, u, { item: f.for, maxPrice: f.max ? amount(f.max, "--max") : undefined });
      const after = tasks(readRows(c.home)).get(t.id)!;
      const out = resultLines(r, after, f.for ?? u);
      c.out(out.lines.join("\n"));
      return out.code;
    }

    case "retry": {
      const t = currentTask(readRows(c.home));
      const d = deps(c, s, t?.cap ?? amount(s.default_cap, "default_cap"));
      if (!pos[1]) {
        const changed = await reconcile(d);
        const still = [...payments(readRows(c.home)).values()].filter((p) => p.state === "open");
        const lines = changed.map((p) => `  ${p.nonce.slice(0, 12)}…  ${p.state === "paid" ? `paid on chain in ${p.tx}, counted once` : "expired unused, hold released"}`);
        lines.push(...still.map((p) => `  ${p.nonce.slice(0, 12)}…  still in flight (${usdc(p.price)} USDC held): tabkeeper retry ${p.nonce}`));
        c.out(lines.length ? lines.join("\n") : "Nothing in flight.");
        return 0;
      }
      const p = findPayment(readRows(c.home), pos[1]);
      const r = await retry(d, pos[1]);
      const out = resultLines(r, tasks(readRows(c.home)).get(p?.task ?? "")!, p?.item ?? pos[1]);
      c.out(out.lines.join("\n"));
      return out.code;
    }

    case "log": {
      const rows = readRows(c.home);
      const t = currentTask(rows);
      const list = [...payments(rows).values()].filter((p) => f.all || p.task === t?.id);
      if (f.json) {
        c.out(JSON.stringify(list.map(({ header, ...p }) => ({ ...p, price: usdc(p.price), validBefore: p.validBefore.toString(), block: p.block.toString() })), null, 1));
        return 0;
      }
      c.out([f.all ? "All payments" : t ? taskLine(t) : "No open task (use --all)", "", ...(list.length ? logLines(list) : ["  no payments"])].join("\n"));
      return 0;
    }

    case "wallet": {
      const acct = c.account();
      if (!acct) throw new Exit(2, `No paying key in ${join(c.home, ".env")}`);
      const client = c.client();
      const [u, p] = await Promise.all([client.readContract({ address: USDC, abi: EIP3009, functionName: "balanceOf", args: [acct.address] }), client.getBalance({ address: acct.address })]);
      c.out(`${acct.address} on ${NETWORK}: ${formatUnits(u, 6)} USDC, ${formatEther(p)} PROS (payments need USDC only; the seller pays the gas)`);
      return 0;
    }

    case "config": {
      if (pos[1] === "set") {
        const next: Settings = { ...s };
        for (const kv of pos.slice(2)) {
          const [k, v] = kv.split("=");
          if (!(k in DEFAULTS) || v === undefined) throw new Exit(2, `Unknown setting ${k}. One of: ${Object.keys(DEFAULTS).join(", ")}`);
          if (k === "sellers") next.sellers = v.split(",").filter(Boolean);
          else if (k === "default_budget" || k === "default_cap") next[k] = usdc(amount(v, k));
          else (next as unknown as Record<string, number>)[k] = Number(v);
        }
        mkdirSync(c.home, { recursive: true });
        writeFileSync(join(c.home, "config.json"), `${JSON.stringify(next, null, 2)}\n`);
        c.out(JSON.stringify(next, null, 2));
        return 0;
      }
      c.out(JSON.stringify(s, null, 2));
      return 0;
    }

    default:
      throw new Exit(2, `Unknown command ${pos[0]}. Run tabkeeper --help`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("tabkeeper.mjs")) {
  const home = homeDir();
  let client: PublicClient | undefined;
  main(process.argv.slice(2), {
    home,
    out: (s) => console.log(s),
    client: () => (client ??= makeClient()),
    account: () => account(home),
    fetch: globalThis.fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  })
    .then((code) => process.exit(code))
    .catch((e) => {
      if (e instanceof Exit) {
        console.error(e.message);
        process.exit(e.code);
      }
      console.error(`Error: ${(e as Error).message.split("\n")[0]}`);
      process.exit(1);
    });
}
