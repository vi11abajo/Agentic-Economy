#!/usr/bin/env node
// trenchscope: checks a Prosper bonding-curve token on Pharos before you buy it, and tells you when to sell.
// Exit codes: 0 done (whatever the verdict), 1 error, 2 needs setup or bad input, 3 needs the user's approval.
import { formatEther, getAddress, isAddress, type Address } from "viem";
import { makeClient, quoteBuy, quoteSell, snapshot, tokenBalance, type MarketSnapshot } from "./chain.js";
import { evaluateBuy, evaluateSell, realHolders, pros, type Decision, type Position } from "./checks.js";
import { ALL_KEYS, KEYS, MIN_CHECKS, decisionChecks, displayPath, formatValue, homeDir, keysOf, loadConfig, parseAssignments, saveConfig, type Config, type KeyInfo } from "./config.js";
import { costBasis, findFills } from "./entry.js";
import { EXPLORER, WPROS, erc20Abi, short } from "./prosper.js";
import { getPosition, loadPositions, logRun, putPosition, readRuns } from "./state.js";
import { renderTrace, utc } from "./trace.js";
import * as trade from "./trade.js";
import { loadEnv, signer } from "./wallet.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const HELP = `trenchscope: on-chain checks for Prosper bonding-curve tokens on Pharos, before you buy and while you hold.

  trenchscope setup                      questions for the first run (thresholds, wallet, key)
  trenchscope config                     show your thresholds
  trenchscope config set k=v [k=v ...]   change them (10k, 5%, 48h, 2d, off all work)
  trenchscope buy <market|token> <PROS>  check a buy of that size: APE or NOPE
  trenchscope sell <market|token> [--wallet 0x...]   check your bag (or any public wallet's): EXIT or HOLD
  trenchscope track <market|token> [--cost <PROS>]   start watching a bag you bought by hand
  trenchscope positions                  bags trenchscope knows about
  trenchscope log [--last N]             the last runs from the log

  --execute   actually trade when the verdict says so (needs a key in .env)
  --approve   the user said yes to the advice flagged in the last check
  --json      machine-readable output

Data lives in ${displayPath(homeDir())} (config.json, positions.json, runs.jsonl, .env).`;

function flags(argv: string[]) {
  const pos: string[] = [];
  const f = { execute: false, approve: false, json: false, cost: undefined as number | undefined, last: 10, wallet: undefined as string | undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") f.execute = true;
    else if (a === "--approve") f.approve = true;
    else if (a === "--json") f.json = true;
    else if (a === "--cost") f.cost = Number(argv[++i]);
    else if (a === "--wallet") f.wallet = argv[++i];
    else if (a === "--last") f.last = Number(argv[++i]);
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

function needConfig(side: "buy" | "sell"): Config {
  const c = loadConfig();
  if (!c) throw new Exit(2, `No thresholds yet. Run \`trenchscope setup\` and ask the user for their values first.`);
  const n = decisionChecks(side, c).length;
  if (n < MIN_CHECKS) throw new Exit(2, `Only ${n} ${side} check(s) are on; trenchscope decides on at least ${MIN_CHECKS}. Set more with \`trenchscope config set\`.`);
  return c;
}

function configTable(c: Config | null): string {
  const lines: string[] = [];
  for (const [s, title] of [["buy", "Buy (all must pass)"], ["sell", "Sell (any one says exit)"], ["general", "General"]] as const) {
    lines.push(title);
    for (const k of keysOf(s)) {
      const info = KEYS[k] as KeyInfo;
      lines.push(`  ${k.padEnd(28)} ${formatValue(c?.values[k], info.unit).padEnd(12)}${info.advisory ? " advice only" : ""}`);
    }
  }
  lines.push(`wallet (public address)      ${c?.wallet ?? "not set"}`);
  return lines.join("\n");
}

function cmdSetup(json: boolean) {
  const c = loadConfig();
  const home = homeDir();
  const env = loadEnv(home);
  const acct = safeSigner(env);
  const questions = ALL_KEYS.map((k) => ({ key: k, section: KEYS[k].section, ask: KEYS[k].ask, unit: KEYS[k].unit, suggestion: formatValue(KEYS[k].suggest, KEYS[k].unit), current: c?.values[k] ?? null, advisory: (KEYS[k] as KeyInfo).advisory ?? false }));
  if (json) return console.log(JSON.stringify({ configured: !!c, questions, wallet: c?.wallet ?? null, signer: acct?.address ?? null, envFile: displayPath(`${home}/.env`) }, null, 2));
  console.log(c ? "Thresholds are already set (you can change any of them):" : "First run: no thresholds yet. Ask the user for each value below (offer the suggestion if they want one).");
  for (const s of ["buy", "sell", "general"] as const) {
    console.log(`\n${s === "buy" ? "BUY: all of these must pass" : s === "sell" ? "SELL: any of these says get out" : "GENERAL"}`);
    for (const q of questions.filter((x) => x.section === s)) {
      console.log(`  ${q.key}${q.advisory ? " (advice only)" : ""}: ${q.ask}\n      suggestion ${q.suggestion}${q.current !== null ? `, now ${formatValue(q.current, KEYS[q.key].unit)}` : ""}`);
    }
  }
  console.log(`\nWALLET\n  wallet: the user's PUBLIC address (0x...). Needed for sell checks, optional for buy. Now: ${c?.wallet ?? "not set"}`);
  console.log(`\nKEY (optional, only for trading by itself)\n  Never ask for a private key or seed phrase in the chat. If the user wants trenchscope to trade, they put\n  PRIVATE_KEY=... (or MNEMONIC="...") into ${displayPath(`${home}/.env`)} themselves. Now: ${acct ? `key found for ${acct.address}` : "no key, advice only"}`);
  console.log(`\nSave with: trenchscope config set wallet=0x... max_fdv_usd=10k min_holders=5 ...`);
}

function safeSigner(env: Record<string, string | undefined>) {
  try {
    return signer(env);
  } catch {
    return null;
  }
}

function cmdConfig(pos: string[], json: boolean) {
  const sub = pos[0] ?? "show";
  if (sub === "show") {
    const c = loadConfig();
    if (json) return console.log(JSON.stringify(c, null, 2));
    if (!c) return console.log("No thresholds yet. Run `trenchscope setup`.");
    console.log(configTable(c));
    for (const side of ["buy", "sell"] as const) {
      const n = decisionChecks(side, c).length;
      console.log(`${side}: ${n} check(s) on${n < MIN_CHECKS ? `, needs at least ${MIN_CHECKS}` : ""}${side === "sell" && !c.wallet ? " (no wallet saved: pass --wallet 0x... or set wallet=0x...)" : ""}`);
    }
    return;
  }
  if (sub === "set") {
    if (pos.length < 2) throw new Exit(2, "Usage: trenchscope config set key=value [key=value ...]");
    let c: Config;
    try {
      c = parseAssignments(pos.slice(1), loadConfig());
    } catch (e) {
      throw new Exit(2, (e as Error).message);
    }
    const file = saveConfig(c);
    console.log(configTable(c));
    console.log(`\nSaved to ${displayPath(file)}. Any threshold can be changed again at any time.`);
    return;
  }
  throw new Exit(2, `Unknown config command "${sub}" (show, set)`);
}

function summary(s: MarketSnapshot) {
  return { market: s.market, token: s.token, symbol: s.symbol, name: s.name, block: s.block, time: utc(s.timestamp), reserve: s.reserve, target: s.target, spot: s.spot, prosUsd: s.prosUsd, phase: s.phase, endsAt: s.endsAt };
}

function emit(json: boolean, s: MarketSnapshot, d: Decision, title: string, extra: Record<string, unknown> = {}) {
  if (json) console.log(JSON.stringify({ ...summary(s), decision: d, ...extra }, null, 2));
  else console.log(renderTrace(s, d, title));
}

async function cmdBuy(pos: string[], f: ReturnType<typeof flags>["f"]) {
  if (pos.length !== 2 || !isAddress(pos[0], { strict: false }) || !(Number(pos[1]) > 0)) throw new Exit(2, "Usage: trenchscope buy <market or token address> <PROS amount>");
  const c = needConfig("buy");
  const size = Number(pos[1]);
  const max = c.values.max_buy_pros ?? null;
  if (max !== null && size > max) throw new Exit(2, `${size} PROS is over your max_buy_pros (${max}). Lower the size or raise the limit.`);
  const home = homeDir();
  const env = loadEnv(home);
  const acct = safeSigner(env);
  const me = c.wallet ?? acct?.address ?? null;
  const client = makeClient();
  const s = await snapshot(client, pos[0]);
  if (s.phase !== 0) throw new Exit(0, `${s.symbol}: the curve isn't trading (phase ${s.phase}), nothing to check.`);
  const q = await quoteBuy(client, s.market, size);
  const d = evaluateBuy(s, c, { pros: size, net: Number(formatEther(q.net)), tokensOut: Number(formatEther(q.tokensOut)) }, me);
  const run: Record<string, unknown> = { at: new Date().toISOString(), cmd: "buy", size, ...summary(s), verdict: d.verdict, reason: d.reason, checks: d.checks };

  if (!f.execute) {
    logRun(home, run);
    emit(f.json, s, d, `buy check · ${size} PROS`);
    if (!f.json && d.fire) {
      console.log(acct
        ? `\nNext: ask the user. On a clear yes run: trenchscope buy ${s.market} ${size} --execute${d.needsApproval ? " --approve" : ""}`
        : `\nNo key in .env, so trenchscope won't buy. The user can buy it on Prosper: market ${s.market}, ${size} PROS (about ${Number(formatEther(q.tokensOut)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s.symbol}).`);
    }
    return;
  }
  emit(f.json, s, d, `buy · ${size} PROS`);
  if (!d.fire) {
    logRun(home, run);
    return console.log(`\nNo trade: ${d.verdict}.`);
  }
  if (d.needsApproval && !f.approve) {
    logRun(home, { ...run, note: "needs approval" });
    throw new Exit(3, "Advice flagged and no --approve. Ask the user first; add --approve only after a clear yes.");
  }
  if (!acct) throw new Exit(2, `No key in ${displayPath(`${home}/.env`)}, so trenchscope can't buy. The user can do it on Prosper: market ${s.market}, ${size} PROS.`);
  if (c.wallet && getAddress(c.wallet) !== acct.address) throw new Exit(2, `The key in .env is for ${acct.address}, but your wallet setting is ${c.wallet}. Fix one of them first.`);

  const minOut = (q.tokensOut * BigInt(Math.round((100 - (c.values.tx_slippage_pct ?? 2)) * 100))) / 10000n;
  const fill = await trade.buy(client, acct, s.market, size, minOut);
  const reserveAfter = Number(formatEther(await client.readContract({ address: WPROS, abi: erc20Abi, functionName: "balanceOf", args: [s.market] })));
  const prev = getPosition(home, acct.address, s.token);
  const real = realHolders(s, c.values.holder_min_pros ?? 0, acct.address);
  const p: Position = prev
    ? { ...prev, cost: prev.cost + fill.pros, tokens: prev.tokens + fill.tokens }
    : { wallet: acct.address, token: s.token, market: s.market, symbol: s.symbol, cost: fill.pros, tokens: fill.tokens, reserve: reserveAfter, holders: real ? real.length : null, block: fill.block, timestamp: s.timestamp, source: "trenchscope buy" };
  putPosition(home, p, acct.address, s.token);
  logRun(home, { ...run, tx: fill.hash, filled: fill });
  console.log(`\nBOUGHT ${fill.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s.symbol} for ${pros(fill.pros)} · block ${fill.block.toLocaleString("en-US")}\n${EXPLORER}/tx/${fill.hash}`);
}

async function bagOf(pos: string[], f: ReturnType<typeof flags>["f"], c: Config | null) {
  if (pos.length !== 1 || !isAddress(pos[0], { strict: false })) throw new Exit(2, "Usage: trenchscope sell|track <market or token address>");
  const home = homeDir();
  const acct = safeSigner(loadEnv(home));
  // --wallet looks at any public address for this one run without touching the saved setting.
  if (f.wallet !== undefined && !isAddress(f.wallet, { strict: false })) throw new Exit(2, "--wallet must be a public 0x address");
  const me = (f.wallet ?? c?.wallet ?? acct?.address ?? null) as Address | null;
  if (!me) throw new Exit(2, "Sell checks need your public wallet address. Ask the user for it and save it: trenchscope config set wallet=0x...");
  const client = makeClient();
  const s = await snapshot(client, pos[0]);
  const bag = await tokenBalance(client, s.token, getAddress(me));
  return { home, acct, me: getAddress(me), client, s, bag };
}

async function entryFor(ctx: Awaited<ReturnType<typeof bagOf>>, c: Config, cost?: number): Promise<{ p: Position; note: string }> {
  const { s, me, bag, client } = ctx;
  const tokens = Number(formatEther(bag));
  const real = realHolders(s, c.values.holder_min_pros ?? 0, me);
  const base = { wallet: me, token: s.token, market: s.market, symbol: s.symbol, tokens, reserve: s.reserve, holders: real ? real.length : null, block: s.block, timestamp: s.timestamp };
  if (cost !== undefined) return { p: { ...base, cost, source: "entered by user" }, note: `entry cost ${pros(cost)} as given` };
  const fills = await findFills(client, s.market, s.token, me);
  const basis = costBasis(fills);
  if (basis.tokens <= 0) return { p: { ...base, cost: 0, source: "found on chain" }, note: `no Prosper buys of ${s.symbol} found for this wallet: P&L can't be checked until the user gives the entry cost (trenchscope track ${s.market} --cost <PROS>)` };
  const cost2 = basis.cost * Math.min(1, tokens / basis.tokens);
  return { p: { ...base, cost: cost2, source: "found on chain" }, note: `entry cost ${pros(cost2)} from ${fills.length} Prosper trade(s) of this wallet; liquidity and holder rules count from now (block ${s.block.toLocaleString("en-US")})` };
}

async function cmdTrack(pos: string[], f: ReturnType<typeof flags>["f"]) {
  const c = loadConfig() ?? { wallet: null, values: {} };
  if (f.cost !== undefined && !(f.cost > 0)) throw new Exit(2, "--cost must be the PROS you paid, e.g. --cost 2.5");
  const ctx = await bagOf(pos, f, c);
  if (ctx.bag === 0n) throw new Exit(0, `No ${ctx.s.symbol} in ${short(ctx.me)}. Nothing to track.`);
  const { p, note } = await entryFor(ctx, c, f.cost);
  putPosition(ctx.home, p, ctx.me, ctx.s.token);
  console.log(`Tracking ${p.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${p.symbol} in ${short(ctx.me)}: ${note}.`);
}

async function cmdSell(pos: string[], f: ReturnType<typeof flags>["f"]) {
  const c = needConfig("sell");
  const ctx = await bagOf(pos, f, c);
  const { s, me, bag, client, home, acct } = ctx;
  if (bag === 0n) {
    logRun(home, { at: new Date().toISOString(), cmd: "sell", ...summary(s), wallet: me, verdict: "HOLD", reason: "no tokens in wallet" });
    return console.log(`No ${s.symbol} in ${short(me)}, nothing to sell.`);
  }
  if (s.phase !== 0) throw new Exit(0, `${s.symbol}: the curve isn't trading (phase ${s.phase}), can't sell through it.`);
  let p = getPosition(home, me, s.token);
  let note = "";
  if (!p) {
    const e = await entryFor(ctx, c);
    p = e.p;
    note = e.note;
    putPosition(home, p, me, s.token);
  }
  const q = await quoteSell(client, s.market, bag);
  const value = Number(formatEther(q.net));
  const d = evaluateSell(s, c, p, { tokens: Number(formatEther(bag)), value }, me);
  const run: Record<string, unknown> = { at: new Date().toISOString(), cmd: "sell", wallet: me, bag: Number(formatEther(bag)), value, entry: p, ...summary(s), verdict: d.verdict, reason: d.reason, checks: d.checks };
  const title = `sell check · ${Number(formatEther(bag)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s.symbol} in ${short(me)}`;
  if (note && !f.json) console.log(`(first check of this bag: ${note})\n`);

  if (!f.execute) {
    logRun(home, run);
    emit(f.json, s, d, title, note ? { note } : {});
    if (!f.json && d.fire) {
      console.log(acct && acct.address === me
        ? `\nNext: ask the user. On a clear yes run: trenchscope sell ${s.market} --execute${d.needsApproval ? " --approve" : ""}`
        : `\nNo key for ${short(me)} in .env, so trenchscope won't sell. The user can sell on Prosper: about ${pros(value)} for the whole bag right now.`);
    }
    return;
  }
  emit(f.json, s, d, title);
  if (!d.fire) {
    logRun(home, run);
    return console.log(`\nNo trade: ${d.verdict}.`);
  }
  if (d.needsApproval && !f.approve) {
    logRun(home, { ...run, note: "needs approval" });
    throw new Exit(3, "Advice flagged and no --approve. Ask the user first; add --approve only after a clear yes.");
  }
  if (!acct) throw new Exit(2, `No key in ${displayPath(`${home}/.env`)}, so trenchscope can't sell. The user can do it on Prosper.`);
  if (acct.address !== me) throw new Exit(2, `The key in .env is for ${acct.address}, but the bag is in ${me}.`);
  const minOut = (q.net * BigInt(Math.round((100 - (c.values.tx_slippage_pct ?? 2)) * 100))) / 10000n;
  const fill = await trade.sell(client, acct, s.market, s.token, bag, minOut);
  putPosition(home, null, me, s.token);
  logRun(home, { ...run, tx: fill.hash, approveTx: fill.approveHash, filled: fill });
  console.log(`\nSOLD ${fill.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 })} ${s.symbol} for ${pros(fill.pros)} · block ${fill.block.toLocaleString("en-US")}\n${EXPLORER}/tx/${fill.hash}`);
}

function cmdPositions(json: boolean) {
  const all = Object.values(loadPositions(homeDir()));
  if (json) return console.log(JSON.stringify(all, null, 2));
  if (all.length === 0) return console.log("No bags tracked yet.");
  for (const p of all) console.log(`${p.symbol.padEnd(10)} ${p.tokens.toLocaleString("en-US", { maximumFractionDigits: 0 }).padStart(14)} in ${short(p.wallet)} · paid ${pros(p.cost)} · since block ${p.block.toLocaleString("en-US")} (${p.source})`);
}

function cmdLog(last: number) {
  const runs = readRuns(homeDir(), last) as { at: string; cmd: string; symbol?: string; verdict?: string; reason?: string; tx?: string }[];
  if (runs.length === 0) return console.log("No runs yet.");
  for (const r of runs) console.log(`${r.at}  ${r.cmd.padEnd(4)} ${(r.symbol ?? "").padEnd(10)} ${(r.verdict ?? "").padEnd(5)} ${r.reason ?? ""}${r.tx ? `  tx ${r.tx}` : ""}`);
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    const { pos, f } = flags(rest);
    switch (cmd) {
      case undefined:
      case "help":
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      case "setup":
        cmdSetup(f.json);
        return 0;
      case "config":
        cmdConfig(pos, f.json);
        return 0;
      case "buy":
        await cmdBuy(pos, f);
        return 0;
      case "sell":
        await cmdSell(pos, f);
        return 0;
      case "track":
        await cmdTrack(pos, f);
        return 0;
      case "positions":
        cmdPositions(f.json);
        return 0;
      case "log":
        cmdLog(f.last);
        return 0;
      default:
        throw new Exit(2, `Unknown command "${cmd}". Run trenchscope --help.`);
    }
  } catch (e) {
    if (e instanceof Exit) {
      (e.code === 0 ? console.log : console.error)(e.message);
      return e.code;
    }
    console.error(`trenchscope: ${(e as Error).message.split("\n")[0]}`);
    return 1;
  }
}

const isMain = process.argv[1] && /(cli\.js|trenchscope(\.mjs)?)$/.test(process.argv[1].replace(/\\/g, "/"));
if (isMain) main(process.argv.slice(2)).then((code) => process.exit(code));
