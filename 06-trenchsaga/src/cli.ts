#!/usr/bin/env node
// trenchsaga: rotate a Prosper curve bag from token A to token B as a saga. Every step is checked on chain
// before the next one starts; transient failures are retried, a permanent one is rolled back.
// Exit codes: 0 done (or nothing to do), 1 error, 2 bad input or setup missing, 3 the saga was rolled back
// (or got stuck while rolling back: see `trenchsaga status`).
import { formatEther, getAddress, isAddress, parseEther, type Address } from "viem";
import { pharosChain, pharosReader, publicClient, resolveToken, rpc } from "./chain.js";
import { EXPLORER } from "./prosper.js";
import { buyStep, pros, rotationSteps, type RotationCtx } from "./rotation.js";
import { Saga, newState, type Faults, type SagaState, type Step } from "./saga.js";
import { DEFAULTS, displayPath, homeDir, journal, listSagas, loadSettings, loadState, readJournal, saveSettings, saveState, signer, type Settings } from "./store.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const HELP = `trenchsaga: rotate a Prosper curve bag from one token to another, as a saga with retries and rollback.

  trenchsaga setup                         data folder, key status, settings
  trenchsaga config set k=v [k=v ...]      max_buy_pros, slippage_pct, max_attempts, receipt_timeout_sec
  trenchsaga plan <A> <B> [--amount N]     what a rotation A -> B would do, no transactions
  trenchsaga rotate <A> <B> --yes          run it: approve A, sell A, unwrap, buy B
  trenchsaga enter <B> <PROS> --yes        buy a first bag of B (one step)
  trenchsaga status [id]                   which step a saga is in (the latest by default)
  trenchsaga resume [id]                   continue an interrupted saga from where it stopped
  trenchsaga log [id]                      the saga's journal, every transition

  A and B are Prosper market addresses (or pToken addresses). --amount is how many A tokens to sell
  (default: all). Demo switches: --fail-at <step> makes that step fail for real (impossible minOut),
  --drop-at <step> sends its first attempt underpriced (1 gwei), so it has to be replaced.

Data lives in ${displayPath(homeDir())}: config.json, .env (the key, you put it there), sagas/, saga.jsonl.`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f = { yes: false, amount: undefined as string | undefined, failAt: undefined as string | undefined, dropAt: undefined as string | undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") f.yes = true;
    else if (a === "--json") f.json = true;
    else if (a === "--amount") f.amount = argv[++i];
    else if (a === "--fail-at") f.failAt = argv[++i];
    else if (a === "--drop-at") f.dropAt = argv[++i];
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

const addr = (s: string | undefined, what: string): Address => {
  if (!s || !isAddress(s, { strict: false })) throw new Exit(2, `${what} must be a Prosper market or pToken address`);
  return getAddress(s);
};

function account(home: string) {
  let a;
  try {
    a = signer(home);
  } catch (e) {
    throw new Exit(2, (e as Error).message);
  }
  if (!a) throw new Exit(2, `No key in ${displayPath(`${home}/.env`)}. The user puts PRIVATE_KEY=0x... there themselves; never paste it into a chat.`);
  return a;
}

/** One readable line per journal event, printed live while the saga runs. */
function echo(e: Record<string, unknown>) {
  const step = String(e.step ?? "");
  const ev = String(e.event ?? "");
  const tx = e.tx ? ` ${EXPLORER}/tx/${e.tx}` : "";
  const bits: string[] = [];
  if (e.attempt) bits.push(`attempt ${e.attempt}`);
  if (e.nonce !== undefined) bits.push(`nonce ${e.nonce}`);
  if (e.maxFeeGwei !== undefined) bits.push(`max fee ${e.maxFeeGwei} gwei${e.underpriced ? " (underpriced on purpose)" : ""}${e.replacing ? ", replacing" : ""}`);
  if (e.sabotage) bits.push("sabotaged on purpose: minOut x10");
  if (e.block) bits.push(`block ${Number(e.block).toLocaleString("en-US")}`);
  if (e.waitedSec) bits.push(`waited ${e.waitedSec}s`);
  const detail = String(e.summary ?? e.reason ?? e.error ?? e.because ?? e.title ?? "").split("\n")[0];
  console.log(`  ${new Date(String(e.at)).toISOString().slice(11, 19)}  ${step.padEnd(24)} ${ev}${bits.length ? ` (${bits.join(", ")})` : ""}${detail ? `: ${detail}` : ""}${tx}`);
}

function renderStatus(s: SagaState<RotationCtx>): string {
  const mark: Record<string, string> = { pending: "·", running: "▶", skipped: "–", verified: "✓", failed: "✗", compensating: "↺", compensated: "↩" };
  const lines = [`saga ${s.id} · ${s.kind} · ${s.status.toUpperCase()}${s.error ? ` · failed at ${s.error}` : ""}${s.stuck ? ` · rollback stopped at ${s.stuck}` : ""}`];
  s.steps.forEach((st, i) => {
    lines.push(`  ${mark[st.state] ?? "?"} ${i + 1}. ${st.name.padEnd(8)} ${st.state.padEnd(12)} ${st.summary ?? st.title}`);
    for (const h of st.txs) lines.push(`       ${EXPLORER}/tx/${h}`);
  });
  return lines.join("\n");
}

async function build(home: string, s: Settings) {
  const acct = account(home);
  const client = publicClient();
  const chain = pharosChain(client, acct);
  const reader = pharosReader(client);
  return { acct, client, chain, reader };
}

function policy(s: Settings) {
  return { maxAttempts: s.max_attempts, receiptTimeoutMs: s.receipt_timeout_sec * 1000, feeMultiplier: 2n };
}

async function runSaga(home: string, s: Settings, steps: Step<RotationCtx>[], state: SagaState<RotationCtx>, faults: Faults, chain: ReturnType<typeof pharosChain>) {
  for (const k of [faults.failAt, faults.dropAt]) if (k && !steps.some((x) => x.name === k)) throw new Exit(2, `No step called "${k}" (steps: ${steps.map((x) => x.name).join(", ")})`);
  const saga = new Saga(steps, state, chain, policy(s), faults, journal(home, echo), (st) => saveState(home, st as SagaState<unknown>));
  console.log(`saga ${state.id}: ${steps.map((x) => x.name).join(" → ")}${faults.failAt ? ` · demo: ${faults.failAt} will fail` : ""}${faults.dropAt ? ` · demo: ${faults.dropAt} sent underpriced first` : ""}`);
  const status = await saga.run();
  console.log(`\n${renderStatus(saga.state)}`);
  return status === "done" ? 0 : 3;
}

async function cmdPlanOrRotate(pos: string[], f: ReturnType<typeof parse>["f"], execute: boolean) {
  const home = homeDir();
  const s = loadSettings(home);
  const { acct, client, chain, reader } = await build(home, s);
  const [a, b] = await Promise.all([resolveToken(client, addr(pos[0], "A")), resolveToken(client, addr(pos[1], "B"))]);
  if (a.token === b.token) throw new Exit(2, "A and B are the same token");
  const held = await reader.tokenBalance(a.token, acct.address);
  if (held === 0n) throw new Exit(2, `No ${a.symbol} in ${acct.address}. Get a first bag with: trenchsaga enter ${a.market} 0.01 --yes`);
  const sellAmount = f.amount && f.amount !== "all" ? parseEther(f.amount) : held;
  if (sellAmount > held) throw new Exit(2, `Only ${formatEther(held)} ${a.symbol} in the wallet`);
  const maxBuy = parseEther(String(s.max_buy_pros));
  const out = await reader.quoteSell(a.market, sellAmount);
  const buyWith = out < maxBuy ? out : maxBuy;
  const getB = await reader.quoteBuy(b.market, buyWith);
  const native = await rpc(() => client.getBalance({ address: acct.address }));
  console.log(`rotation ${a.symbol} → ${b.symbol} for ${acct.address}
  1. approve   the Prosper router to take ${formatEther(sellAmount)} ${a.symbol}
  2. sell      ${formatEther(sellAmount)} ${a.symbol} → about ${pros(out)} as WPROS (quote now)
  3. unwrap    that WPROS → PROS
  4. buy       ${b.symbol} with ${pros(buyWith)}${out > maxBuy ? ` (capped by max_buy_pros ${s.max_buy_pros}; the rest stays as PROS)` : ""} → about ${Number(formatEther(getB)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${b.symbol}
  if a step fails for good, the done steps are undone in reverse: buy ${a.symbol} back, restore the allowance
  slippage limit ${s.slippage_pct}%, up to ${s.max_attempts} attempts per step, ${s.receipt_timeout_sec}s to get mined · wallet has ${pros(native)} for gas`);
  if (!execute) return 0;
  if (!f.yes) throw new Exit(2, "Not sent: rotate needs --yes, after the user said yes in the chat.");
  const ctx: RotationCtx = { me: acct.address, a, b, sellAmount, slippageBps: Math.round(s.slippage_pct * 100), maxBuy };
  const steps = rotationSteps(reader);
  const id = `rotate-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  return runSaga(home, s, steps, newState(id, "rotate", steps, ctx), { failAt: f.failAt, dropAt: f.dropAt }, chain);
}

async function cmdEnter(pos: string[], f: ReturnType<typeof parse>["f"]) {
  const home = homeDir();
  const s = loadSettings(home);
  const { acct, client, chain, reader } = await build(home, s);
  const b = await resolveToken(client, addr(pos[0], "B"));
  const value = parseEther(pos[1] ?? "0");
  const maxBuy = parseEther(String(s.max_buy_pros));
  if (value <= 0n) throw new Exit(2, "Usage: trenchsaga enter <market> <PROS> --yes");
  if (value > maxBuy) throw new Exit(2, `${pos[1]} PROS is over max_buy_pros (${s.max_buy_pros})`);
  console.log(`enter ${b.symbol}: buy with ${pros(value)} → about ${Number(formatEther(await reader.quoteBuy(b.market, value))).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${b.symbol}`);
  if (!f.yes) throw new Exit(2, "Not sent: enter needs --yes, after the user said yes in the chat.");
  const ctx: RotationCtx = { me: acct.address, b, sellAmount: 0n, slippageBps: Math.round(s.slippage_pct * 100), maxBuy, enterValue: value };
  const steps = [buyStep(reader, `Buy ${b.symbol} with PROS`, (c) => c.enterValue!)];
  const id = `enter-${new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)}`;
  return runSaga(home, s, steps, newState(id, "enter", steps, ctx), { failAt: f.failAt, dropAt: f.dropAt }, chain);
}

function pickId(home: string, id?: string) {
  const all = listSagas(home);
  const chosen = id ?? all.at(-1);
  if (!chosen || !all.includes(chosen)) throw new Exit(2, id ? `No saga ${id}` : "No sagas yet");
  return chosen;
}

async function cmdResume(pos: string[]) {
  const home = homeDir();
  const s = loadSettings(home);
  const id = pickId(home, pos[0]);
  const state = loadState<RotationCtx>(home, id);
  if (state.status === "done" || state.status === "compensated") return console.log(renderStatus(state)), 0;
  const { reader, chain } = await build(home, s);
  const steps = state.kind === "enter" ? [buyStep(reader, state.steps[0].title, (c) => c.enterValue!)] : rotationSteps(reader);
  for (const st of state.steps) if (st.state === "running") st.state = "pending"; // it re-checks its pending txs first
  if (state.status === "stuck") state.status = "compensating";
  return runSaga(home, s, steps, state, {}, chain);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const { pos, f } = parse(rest);
    const home = homeDir();
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
        console.log(HELP);
        return 0;
      case "setup": {
        let key = "no key";
        try {
          const a = signer(home);
          key = a ? `key found for ${a.address}` : `no key: put PRIVATE_KEY=0x... into ${displayPath(`${home}/.env`)} yourself`;
        } catch (e) {
          key = (e as Error).message;
        }
        console.log(`data folder ${displayPath(home)}\n${key}\nsettings ${JSON.stringify(loadSettings(home))}`);
        return 0;
      }
      case "config": {
        if (pos[0] !== "set") return console.log(JSON.stringify(loadSettings(home), null, 2)), 0;
        const s = loadSettings(home);
        for (const kv of pos.slice(1)) {
          const [k, v] = kv.split("=");
          if (!(k in DEFAULTS) || !(Number(v) > 0)) throw new Exit(2, `Bad setting ${kv} (known: ${Object.keys(DEFAULTS).join(", ")})`);
          (s as unknown as Record<string, number>)[k] = Number(v);
        }
        console.log(`saved to ${displayPath(saveSettings(home, s))}: ${JSON.stringify(s)}`);
        return 0;
      }
      case "plan":
        return await cmdPlanOrRotate(pos, f, false);
      case "rotate":
        return await cmdPlanOrRotate(pos, f, true);
      case "enter":
        return await cmdEnter(pos, f);
      case "status":
        console.log(renderStatus(loadState<RotationCtx>(home, pickId(home, pos[0]))));
        return 0;
      case "resume":
        return await cmdResume(pos);
      case "log":
        for (const e of readJournal(home, pickId(home, pos[0]))) echo(e);
        return 0;
      default:
        throw new Exit(2, `Unknown command "${cmd}". Run trenchsaga --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      (e.code === 0 ? console.log : console.error)(e.message);
      return e.code;
    }
    console.error(`trenchsaga: ${String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message).split("\n")[0]}`);
    return 1;
  }
}

const isMain = process.argv[1] && /(cli\.js|trenchsaga(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
