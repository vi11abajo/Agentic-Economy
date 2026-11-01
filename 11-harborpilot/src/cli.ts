#!/usr/bin/env node
// harborpilot: one interface over the Pharos Harbor vaults. Reads every venue at one block, routes a deposit to
// the best one for the user's conditions and says why (and why not each of the others), and prepares, checks
// and sends deposits, withdrawals, claims and a Morpho loan against PROS.
// Exit codes: 0 ok, 1 error, 2 bad input or no key, 3 blocked (a check failed, nothing sent).
import { pathToFileURL } from "node:url";
import { formatEther, formatUnits, getAddress, isAddress, parseEther, parseUnits, type Account, type Address, type PublicClient } from "viem";
import { position, quote, sharesFor, depositSteps, withdrawSteps, claimSteps, ERC20, type Ctx, type Quote } from "./adapters.js";
import { blocksAgo, EXPLORER, makeClient, morphoCollateralOverride, pinnedBlock, tokenOverride, USDC, WPROS, withTimeout, type Step } from "./chain.js";
import { checkPlan, sendPlan, type RequestRef, type StepCheck } from "./exec.js";
import { borrowSteps, health, loanOf, marketState, repaySteps, WPROS_MARKET } from "./morpho.js";
import { DEFAULT_CONDITIONS, rankedApy, route, type Conditions } from "./router.js";
import { DEFAULTS, type Settings } from "./settings.js";
import { displayPath, homeDir, journal, loadSettings, readJournal, saveSettings, signer } from "./store.js";
import { findVenue, MORPHO, VENUES, type Venue } from "./venues.js";

class Exit extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

/** A random address used to check venues when there is no wallet: the result doesn't depend on whose it is. */
export const PROBE: Address = "0x59f7000000000000000000000000000000005f64";

const HELP = `harborpilot: the Pharos Harbor vaults behind one interface. Checks all of them, picks the best for you.

  harborpilot venues [--amount N]                 every Harbor asset: open or not and why, TVL, yield 7d/30d, exit
  harborpilot best <USDC> [conditions]            the best venue for this deposit, why, and why not each other one
  harborpilot positions [address]                 what an address holds in every venue, open requests, the Morpho loan
  harborpilot deposit <venue|best> <USDC> [conditions] [--yes]
  harborpilot withdraw <venue> <USDC|all> [--yes] take out at once, or file the redemption request
  harborpilot claim [venue] [--yes]               claim filled deposit / redemption requests
  harborpilot borrow --pros <N> --usdc <N> [--yes]  post PROS as collateral on Morpho and borrow USDC against it
  harborpilot repay [--yes]                       repay the whole loan and take the PROS back
  harborpilot log | wallet | config [set k=v ...]

  conditions:
    --exit-days N     I need my money back within N days (0 = at once)
    --sync-only       only venues that take the deposit at once (not as a request)
    --stable          skip venues whose share price fell over the last 7 or 30 days
    --horizon D       how long the money stays, to spread an exit fee (default 90)
    --region XX       skip venues Harbor marks as not for this country (US, CN, ...)

  Without --yes nothing is signed: the plan is simulated and shown. With --yes each step is simulated again
  right before it is signed, and the run stops at the first step that would fail.
  Venues: ${VENUES.map((v) => v.id).join(", ")}
Data lives in ${displayPath(homeDir())}: config.json, journal.jsonl, .env (the key, you put it there).`;

function parse(argv: string[]) {
  const pos: string[] = [];
  const f = {
    yes: false,
    json: false,
    amount: undefined as string | undefined,
    exitDays: undefined as number | undefined,
    syncOnly: false,
    stable: false,
    horizon: DEFAULT_CONDITIONS.horizonDays,
    region: undefined as string | undefined,
    pros: undefined as string | undefined,
    usdc: undefined as string | undefined,
    from: undefined as string | undefined,
    last: 15,
  };
  const num = (s: string | undefined, what: string) => {
    const n = Number(s);
    if (s === undefined || !Number.isFinite(n) || n < 0) throw new Exit(2, `${what} needs a number (got ${s ?? "nothing"})`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") pos.unshift("help");
    else if (a === "--yes") f.yes = true;
    else if (a === "--json") f.json = true;
    else if (a === "--amount") f.amount = argv[++i];
    else if (a === "--exit-days") f.exitDays = num(argv[++i], a);
    else if (a === "--sync-only") f.syncOnly = true;
    else if (a === "--stable") f.stable = true;
    else if (a === "--horizon") f.horizon = Math.max(1, num(argv[++i], a));
    else if (a === "--region") f.region = (argv[++i] ?? "").toUpperCase();
    else if (a === "--pros") f.pros = argv[++i];
    else if (a === "--usdc") f.usdc = argv[++i];
    else if (a === "--from") f.from = argv[++i];
    else if (a === "--last") f.last = num(argv[++i], a);
    else if (a.startsWith("--")) throw new Exit(2, `Unknown option ${a}`);
    else pos.push(a);
  }
  return { pos, f };
}

const usdcUnits = (s: string | undefined, what = "the amount") => {
  if (!s || !/^\d+(\.\d{1,6})?$/.test(s) || Number(s) <= 0) throw new Exit(2, `${what} must be a USDC amount like 25 or 2.5 (got ${s ?? "nothing"})`);
  return parseUnits(s, 6);
};
const prosUnits = (s: string | undefined) => {
  if (!s || !/^\d+(\.\d{1,18})?$/.test(s)) throw new Exit(2, `--pros must be a PROS amount like 0.05 (got ${s ?? "nothing"})`);
  return parseEther(s);
};
const venueOf = (id: string | undefined): Venue => {
  const v = id ? findVenue(id) : undefined;
  if (!v) throw new Exit(2, `Unknown venue ${id ?? "(none)"}. One of: ${VENUES.map((x) => x.id).join(", ")}`);
  return v;
};

const fmt = (x: number | undefined, d = 2) => (x === undefined || !Number.isFinite(x) ? "-" : x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
const pct = (x: number | undefined) => (x === undefined || !Number.isFinite(x) ? "-" : `${x.toFixed(2)}%`);
const big = (x: number | undefined) => {
  if (x === undefined) return "-";
  if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
  if (x >= 1e3) return `${(x / 1e3).toFixed(1)}K`;
  return x.toFixed(2);
};
const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));
const exitText = (q: Quote) => {
  if (q.exitDays === undefined) return q.status === "open" ? "?" : "-";
  if (q.exitDays === 0) return q.venue.kind === "vault-v2" ? "at once" : "T+0 req";
  return `${Number(q.exitDays.toFixed(1))} d`;
};

export interface Deps {
  client: PublicClient;
  home: string;
  out: (s: string) => void;
  account: () => Account | null;
}

async function context(client: PublicClient): Promise<Ctx> {
  const now = await pinnedBlock(client);
  return { client, ...now, past: await blocksAgo(client, now, [7, 30]) };
}

/** Quote every venue at once; one that throws or is too slow is "down" and the others carry on. */
export async function quoteAll(ctx: Ctx, from: Address, amount: bigint, s: Settings, venues = VENUES, quoter = quote): Promise<Quote[]> {
  const res = await Promise.allSettled(venues.map((v) => withTimeout(quoter(ctx, v, from, amount), s.venue_timeout_ms, v.name)));
  return res.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { venue: venues[i], status: "down", reason: (r.reason as Error)?.message?.split("\n")[0] ?? String(r.reason), decimals: 6, apy: {}, exitHow: "", exitFeePct: 0, asyncDeposit: false, notes: [] },
  );
}

function venuesTable(qs: Quote[], amount: number): string[] {
  const lines = [`  ${pad("venue", 28)} ${pad("protocol", 16)} ${"TVL".padStart(8)} ${"7d".padStart(7)} ${"30d".padStart(7)} ${"exit".padStart(8)}  ${amount} USDC deposit now`];
  const order = (q: Quote) => (q.status === "open" ? 0 : q.status === "closed" && q.venue.kind !== "token-only" ? 1 : q.status === "down" ? 2 : 3);
  for (const q of [...qs].sort((a, b) => order(a) - order(b) || (rankedApy(b) ?? -99) - (rankedApy(a) ?? -99))) {
    const state = q.status === "open" ? "OPEN" : q.status === "down" ? `DOWN: ${q.reason}` : `closed: ${q.reason}`;
    const tvl = q.venue.kind === "token-only" ? (q.tvl !== undefined ? `${big(q.tvl)} tok` : "-") : big(q.tvl);
    lines.push(`  ${pad(q.venue.id + " " + q.venue.name.replace(/\s*\(.*\)$/, ""), 28)} ${pad(q.venue.protocol, 16)} ${tvl.padStart(8)} ${pct(q.apy.d7).padStart(7)} ${pct(q.apy.d30).padStart(7)} ${exitText(q).padStart(8)}  ${state}`);
  }
  return lines;
}

function conditionsOf(f: ReturnType<typeof parse>["f"], amount: number): Conditions {
  return { amount, maxExitDays: f.exitDays, allowAsyncDeposit: !f.syncOnly, stableOnly: f.stable, horizonDays: f.horizon, region: f.region };
}

function conditionsText(c: Conditions): string {
  const parts = [`${c.amount} USDC`];
  parts.push(c.maxExitDays === undefined ? "any exit time" : c.maxExitDays === 0 ? "out at once" : `out within ${c.maxExitDays} days`);
  if (!c.allowAsyncDeposit) parts.push("deposit filled at once");
  if (c.stableOnly) parts.push("steady share price");
  if (c.region) parts.push(`region ${c.region}`);
  parts.push(`${c.horizonDays}-day horizon`);
  return parts.join(", ");
}

function routeText(qs: Quote[], c: Conditions, block: bigint): string[] {
  const r = route(qs, c);
  const lines = [`Best Harbor venue for ${conditionsText(c)}  (all ${qs.length} checked at block ${block.toLocaleString("en-US")})`, ""];
  if (r.ranked.length) {
    lines.push(`  ${pad("#  venue", 34)} ${"yield".padStart(7)} ${"net".padStart(7)} ${"exit".padStart(8)}  ${"TVL".padStart(8)}`);
    r.ranked.forEach((x, i) => {
      lines.push(`  ${pad(`${i + 1}  ${x.quote.venue.id} ${x.quote.venue.name.replace(/\s*\(.*\)$/, "")}`, 34)} ${pct(x.apy).padStart(7)} ${pct(x.net).padStart(7)} ${exitText(x.quote).padStart(8)}  ${big(x.quote.tvl).padStart(8)}`);
    });
    lines.push("");
  }
  lines.push(`PICK  ${r.ranked[0] ? r.ranked[0].quote.venue.id : "none"}`);
  for (const e of r.explanation) lines.push(`  ${e}`);
  for (const n of r.ranked[0]?.quote.notes ?? []) lines.push(`  Note: ${n}.`);
  const regions = r.ranked[0]?.quote.venue.harbor.regions;
  if (regions && regions !== "-") lines.push(`  Note: Harbor says "${regions}" for this one.`);
  if (r.excluded.length) {
    lines.push("", "Left out:");
    for (const e of r.excluded) lines.push(`  ${pad(e.quote.venue.id, 10)} ${e.why}`);
  }
  if (r.down.length) {
    lines.push("", "Didn't answer (left out, the others were compared without them):");
    for (const e of r.down) lines.push(`  ${pad(e.quote.venue.id, 10)} ${e.why}`);
  }
  return lines;
}

function planText(title: string, checks: StepCheck[]): string[] {
  const lines = [title];
  checks.forEach((c, i) => lines.push(`  ${i + 1}. ${c.ok ? "OK    " : "FAILS "} ${c.step.label}${c.step.value ? ` (sends ${formatEther(c.step.value)} PROS)` : ""}${c.ok ? "" : `\n            ${c.reason}`}`));
  return lines;
}

/** Ids of the requests this tool filed in a vault for `user`, from the journal. */
export function journalRequestIds(rows: Record<string, unknown>[], vault: Address, user: Address): bigint[] {
  const ids: bigint[] = [];
  for (const row of rows) {
    if (row.event !== "sent" || !Array.isArray(row.txs)) continue;
    for (const tx of row.txs as { requests?: RequestRef[] }[])
      for (const r of tx.requests ?? []) if (r.vault.toLowerCase() === vault.toLowerCase() && r.controller.toLowerCase() === user.toLowerCase()) ids.push(BigInt(r.id));
  }
  return ids;
}

async function needSigner(d: Deps): Promise<Account> {
  const a = d.account();
  if (!a) throw new Exit(2, `No key. Put PRIVATE_KEY=... into ${displayPath(homeDir())}/.env (or point HARBORPILOT_ENV_FILE at an .env). Without a key, use --from <address> to check a plan.`);
  return a;
}

/** Simulate the plan; with --yes send it. Returns the exit code. */
async function runPlan(d: Deps, from: Address, title: string, steps: Step[], yes: boolean, account: Account | null, base: Parameters<typeof checkPlan>[3] = []): Promise<number> {
  const checks = await checkPlan(d.client, from, steps, base);
  d.out(planText(title, checks).join("\n"));
  const ok = checks.every((c) => c.ok);
  journal(d.home, { event: "plan", title, from, ok, steps: checks.map((c) => ({ label: c.step.label, ok: c.ok, reason: c.reason })) });
  if (!ok) {
    d.out("\nBLOCKED  a step fails in simulation; nothing was signed.");
    return 3;
  }
  if (!yes) {
    d.out(`\nAll ${steps.length} step(s) pass in simulation. Run the same command with --yes to sign and send them.`);
    return 0;
  }
  if (!account || account.address.toLowerCase() !== from.toLowerCase()) throw new Exit(2, "--yes signs with the key in .env, so the plan must be for that wallet (drop --from).");
  d.out("\nSending:");
  const r = await sendPlan(d.client, account, steps, { log: d.out, gasBufferPct: loadSettings(d.home).gas_buffer_pct });
  journal(d.home, { event: "sent", title, txs: r.sent.map((s) => ({ label: s.step.label, hash: s.hash, status: s.status, block: s.block?.toString(), requests: s.requests?.length ? s.requests : undefined })), stopped: r.stopped });
  if (r.stopped) {
    d.out(`\nSTOPPED  ${r.stopped}`);
    return 3;
  }
  d.out(`\nDONE  ${r.sent.length} transaction(s) confirmed.`);
  return 0;
}

export async function main(argv: string[], d: Deps): Promise<number> {
  const { pos, f } = parse(argv);
  const cmd = pos[0] ?? "help";
  const s = loadSettings(d.home);
  const who = (): { from: Address; account: Account | null } => {
    const account = d.account();
    if (f.from) {
      if (!isAddress(f.from, { strict: false })) throw new Exit(2, `--from must be an address (got ${f.from})`);
      return { from: getAddress(f.from), account };
    }
    return { from: account?.address ?? PROBE, account };
  };

  switch (cmd) {
    case "help":
    case "--help":
    case "-h": {
      const a = d.account();
      d.out(`${HELP}\nWallet: ${a ? a.address : "no key yet"}`);
      return 0;
    }

    case "venues":
    case "rates": {
      const amount = f.amount ? Number(f.amount) : 100;
      const ctx = await context(d.client);
      const qs = await quoteAll(ctx, who().from, usdcUnits(String(amount)), s);
      d.out([`All ${qs.length} Harbor assets at block ${ctx.block.toLocaleString("en-US")}. "OPEN" = a ${amount} USDC deposit passes in simulation right now.`, "", ...venuesTable(qs, amount)].join("\n"));
      const notes = qs.filter((q) => q.status === "open" && q.notes.length);
      if (notes.length) d.out(["", ...notes.flatMap((q) => q.notes.map((n) => `  ${q.venue.id}: ${n}`))].join("\n"));
      return 0;
    }

    case "best": {
      const units = usdcUnits(pos[1]);
      const c = conditionsOf(f, Number(pos[1]));
      const ctx = await context(d.client);
      const qs = await quoteAll(ctx, who().from, units, s);
      const lines = routeText(qs, c, ctx.block);
      d.out(lines.join("\n"));
      journal(d.home, { event: "route", conditions: c, pick: route(qs, c).ranked[0]?.quote.venue.id ?? null, block: ctx.block.toString() });
      return 0;
    }

    case "positions": {
      const user = pos[1] ? (isAddress(pos[1], { strict: false }) ? getAddress(pos[1]) : null) : who().from;
      if (!user || user === PROBE) throw new Exit(2, "Whose positions? Give an address, or put a key in .env.");
      const ctx = await context(d.client);
      const rows = readJournal(d.home);
      const res = await Promise.allSettled(VENUES.map((v) => withTimeout(position(ctx, v, user, journalRequestIds(rows, v.address, user)), s.venue_timeout_ms, v.name)));
      const lines = [`Positions of ${user} at block ${ctx.block.toLocaleString("en-US")}`, ""];
      let held = 0;
      res.forEach((r, i) => {
        const v = VENUES[i];
        if (r.status === "rejected") return void lines.push(`  ${pad(v.id, 10)} DOWN: ${(r.reason as Error).message.split("\n")[0]}`);
        const p = r.value;
        const extra = [
          p.pendingDeposit ? `deposit request pending ${fmt(p.pendingDeposit)} USDC` : "",
          p.claimableDeposit ? `deposit ready to claim ${fmt(p.claimableDeposit)} USDC` : "",
          p.pendingRedeem ? `redemption pending ${fmt(p.pendingRedeem, 4)} shares` : "",
          p.claimableRedeem ? `redemption ready to claim ${fmt(p.claimableRedeem, 4)} shares` : "",
        ].filter(Boolean);
        if (!p.shares && !extra.length) return;
        held++;
        const value = v.kind === "token-only" ? `${fmt(p.assets, 6)} tokens` : `${fmt(p.assets, 6)} USDC`;
        const holding = p.shares ? `${formatUnits(p.shares, p.shareDecimals)} shares = ${value}` : "";
        lines.push(`  ${pad(v.id, 10)} ${[holding, ...extra].filter(Boolean).join("; ")}`);
      });
      if (!held) lines.push("  nothing in any of the 16 Harbor venues");
      const m = await marketState(ctx);
      const loan = await loanOf(ctx, m, user);
      if (loan.collateral || loan.borrowShares) {
        lines.push(
          "",
          `  Morpho loan (USDC against WPROS): ${formatEther(loan.collateral)} WPROS posted, ${formatUnits(loan.debt, 6)} USDC owed`,
          `    LTV ${(loan.ltv * 100).toFixed(2)}% of ${(m.lltv * 100).toFixed(1)}% allowed; liquidation if WPROS < ${loan.liquidationPrice.toFixed(4)} USDC (now ${m.price.toFixed(4)})`,
        );
      }
      d.out(lines.join("\n"));
      return 0;
    }

    case "deposit": {
      const units = usdcUnits(pos[2]);
      const amount = Number(pos[2]);
      if (amount > s.max_usdc_per_deposit) throw new Exit(3, `${amount} USDC is over max_usdc_per_deposit (${s.max_usdc_per_deposit}). Nothing done.`);
      const { from, account } = who();
      if (f.yes) await needSigner(d);
      const ctx = await context(d.client);
      let v: Venue;
      if ((pos[1] ?? "").toLowerCase() === "best") {
        const qs = await quoteAll(ctx, from, units, s);
        const c = conditionsOf(f, amount);
        d.out(routeText(qs, c, ctx.block).join("\n"));
        const best = route(qs, c).ranked[0];
        if (!best) return 3;
        v = best.quote.venue;
        d.out("");
      } else {
        v = venueOf(pos[1]);
      }
      if (from === PROBE) throw new Exit(2, "Deposit from which wallet? Put a key in .env, or use --from <address> to check the plan.");
      const have = (await d.client.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [from] })) as bigint;
      if (have < units) throw new Exit(3, `The wallet has ${formatUnits(have, 6)} USDC, the deposit needs ${amount}. Nothing done.`);
      const steps = depositSteps(v, from, units);
      steps[0].after = tokenOverride(USDC, from, { spender: v.address, allowance: units });
      return runPlan(d, from, `Plan: ${amount} USDC into ${v.name} (${v.protocol}), from ${from}`, steps, f.yes, account);
    }

    case "withdraw": {
      const v = venueOf(pos[1]);
      if (v.kind === "token-only") throw new Exit(2, `${v.name}: ${v.why}`);
      const all = (pos[2] ?? "").toLowerCase() === "all";
      const units = all ? "all" : usdcUnits(pos[2]);
      const { from, account } = who();
      if (from === PROBE) throw new Exit(2, "Whose position? Put a key in .env, or use --from <address>.");
      if (f.yes) await needSigner(d);
      const ctx = await context(d.client);
      const shares = await sharesFor(ctx, v, from, units);
      if (!shares) throw new Exit(3, `${from} holds no ${v.name} shares. Nothing done.`);
      const q = await quote(ctx, v, from, 1_000_000n);
      const steps = withdrawSteps(v, from, shares, q.exitNativeFee ?? 0n);
      const dec = (await d.client.readContract({ address: v.share ?? v.address, abi: ERC20, functionName: "decimals" })) as number;
      d.out(`Exit from ${v.name}: ${q.exitHow}.${q.exitFeePct ? ` Exit fee ${q.exitFeePct}%.` : ""}`);
      return runPlan(d, from, `Plan: ${all ? "everything" : `${pos[2]} USDC`} out of ${v.name} (${formatUnits(shares, dec)} shares)`, steps, f.yes, account);
    }

    case "claim": {
      const { from, account } = who();
      if (from === PROBE) throw new Exit(2, "Whose requests? Put a key in .env, or use --from <address>.");
      if (f.yes) await needSigner(d);
      const ctx = await context(d.client);
      const list = pos[1] ? [venueOf(pos[1])] : VENUES.filter((v) => !["vault-v2", "r25-sync", "token-only"].includes(v.kind));
      const steps: Step[] = [];
      const rows = readJournal(d.home);
      for (const v of list) steps.push(...claimSteps(v, from, await position(ctx, v, from, journalRequestIds(rows, v.address, from))));
      if (!steps.length) {
        d.out("Nothing is ready to claim.");
        return 0;
      }
      return runPlan(d, from, `Plan: claim filled requests for ${from}`, steps, f.yes, account);
    }

    case "borrow": {
      const pros = f.pros ? prosUnits(f.pros) : 0n;
      const usdc = f.usdc ? usdcUnits(f.usdc, "--usdc") : 0n;
      if (!pros && !usdc) throw new Exit(2, "borrow needs --pros (collateral to post) and/or --usdc (to borrow).");
      const { from, account } = who();
      if (from === PROBE) throw new Exit(2, "Borrow from which wallet? Put a key in .env, or use --from <address>.");
      if (f.yes) await needSigner(d);
      const ctx = await context(d.client);
      const m = await marketState(ctx);
      const loan = await loanOf(ctx, m, from);
      const after = health(loan.collateral + pros, loan.debt + usdc, m);
      d.out(
        [
          `Morpho market USDC / WPROS (the one roxUSDC lends into): WPROS = ${m.price.toFixed(4)} USDC, liquidation at LTV ${(m.lltv * 100).toFixed(1)}%`,
          `  borrow rate ${m.borrowApy.toFixed(2)}% a year, ${fmt(m.free)} USDC free to borrow`,
          `  after this: ${formatEther(loan.collateral + pros)} WPROS posted, ${formatUnits(loan.debt + usdc, 6)} USDC owed, LTV ${(after.ltv * 100).toFixed(2)}%` +
            (after.liquidationPrice ? `, liquidation if WPROS < ${after.liquidationPrice.toFixed(4)} USDC` : ""),
          "",
        ].join("\n"),
      );
      if (after.ltv > s.max_ltv) throw new Exit(3, `LTV ${(after.ltv * 100).toFixed(2)}% is over max_ltv ${(s.max_ltv * 100).toFixed(0)}%. Post more PROS or borrow less. Nothing done.`);
      if (Number(formatUnits(usdc, 6)) > m.free) throw new Exit(3, `Only ${fmt(m.free)} USDC is free to borrow. Nothing done.`);
      const bal = await d.client.getBalance({ address: from });
      if (pros && bal < pros + parseEther("0.01")) throw new Exit(3, `The wallet has ${formatEther(bal)} PROS; posting ${formatEther(pros)} and keeping 0.01 for gas needs more. Nothing done.`);
      const wprosBal = (await d.client.readContract({ address: WPROS, abi: ERC20, functionName: "balanceOf", args: [from] })) as bigint;
      const steps = borrowSteps(m.params, from, pros, usdc);
      if (pros) {
        steps[0].after = tokenOverride(WPROS, from, { balance: wprosBal + pros });
        steps[1].after = tokenOverride(WPROS, from, { spender: MORPHO, allowance: pros });
        steps[2].after = morphoCollateralOverride(MORPHO, WPROS_MARKET, from, loan.collateral + pros, loan.borrowShares);
      }
      return runPlan(d, from, `Plan: ${pros ? `post ${formatEther(pros)} PROS` : ""}${pros && usdc ? ", " : ""}${usdc ? `borrow ${formatUnits(usdc, 6)} USDC` : ""} (from ${from})`, steps, f.yes, account);
    }

    case "repay": {
      const { from, account } = who();
      if (from === PROBE) throw new Exit(2, "Whose loan? Put a key in .env, or use --from <address>.");
      if (f.yes) await needSigner(d);
      const ctx = await context(d.client);
      const m = await marketState(ctx);
      const loan = await loanOf(ctx, m, from);
      if (!loan.collateral && !loan.borrowShares) {
        d.out("No Morpho loan or collateral for this wallet.");
        return 0;
      }
      const have = (await d.client.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [from] })) as bigint;
      if (have < loan.debt) throw new Exit(3, `The loan is ${formatUnits(loan.debt, 6)} USDC, the wallet has ${formatUnits(have, 6)}. Nothing done.`);
      const steps = repaySteps(m.params, from, loan);
      const wprosBal = (await d.client.readContract({ address: WPROS, abi: ERC20, functionName: "balanceOf", args: [from] })) as bigint;
      let i = 0;
      if (loan.borrowShares) {
        steps[i++].after = tokenOverride(USDC, from, { spender: MORPHO, allowance: loan.debt * 2n });
        steps[i++].after = morphoCollateralOverride(MORPHO, WPROS_MARKET, from, loan.collateral, 0n);
      }
      if (loan.collateral) steps[i].after = tokenOverride(WPROS, from, { balance: wprosBal + loan.collateral });
      return runPlan(d, from, `Plan: repay ${formatUnits(loan.debt, 6)} USDC and take back ${formatEther(loan.collateral)} PROS (from ${from})`, steps, f.yes, account);
    }

    case "wallet": {
      const a = d.account();
      if (!a) return d.out(`No key in ${displayPath(homeDir())}/.env`), 2;
      const [pros, usdc] = await Promise.all([d.client.getBalance({ address: a.address }), d.client.readContract({ address: USDC, abi: ERC20, functionName: "balanceOf", args: [a.address] }) as Promise<bigint>]);
      d.out(`${a.address}\n  ${formatEther(pros)} PROS, ${formatUnits(usdc, 6)} USDC\n  ${EXPLORER}/address/${a.address}`);
      return 0;
    }

    case "config": {
      if (pos[1] === "set") {
        const next = { ...s } as Record<string, number>;
        for (const kv of pos.slice(2)) {
          const [k, v] = kv.split("=");
          if (!(k in DEFAULTS) || !Number.isFinite(Number(v))) throw new Exit(2, `config set takes ${Object.keys(DEFAULTS).join(", ")} = number`);
          next[k] = Number(v);
        }
        d.out(`Saved ${displayPath(saveSettings(d.home, next as unknown as Settings))}`);
      }
      d.out(JSON.stringify(loadSettings(d.home), null, 2));
      return 0;
    }

    case "log": {
      const rows = readJournal(d.home).slice(-f.last);
      if (!rows.length) return d.out("Nothing yet."), 0;
      for (const e of rows) {
        const at = String(e.at).replace("T", " ").slice(0, 19);
        if (e.event === "route") d.out(`${at}  route   pick ${e.pick ?? "none"}`);
        else if (e.event === "plan") d.out(`${at}  plan    ${e.ok ? "passes" : "FAILS "}  ${e.title}`);
        else if (e.event === "sent") {
          d.out(`${at}  sent    ${e.title}${e.stopped ? `  (stopped: ${e.stopped})` : ""}`);
          for (const t of (e.txs as { hash: string; status: string }[]) ?? []) d.out(`                       ${t.status}  ${EXPLORER}/tx/${t.hash}`);
        }
      }
      return 0;
    }

    default:
      throw new Exit(2, `Unknown command ${cmd}. Run harborpilot --help`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href || process.argv[1]?.endsWith("harborpilot.mjs")) {
  const home = homeDir();
  main(process.argv.slice(2), { client: makeClient(), home, out: (s) => console.log(s), account: () => signer(home) })
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
