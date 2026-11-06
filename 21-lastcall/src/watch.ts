// The watchdog proper: one round = look at every loan, compare with what we remembered, and decide what deserves
// a message. Four reasons to speak up:
//   level     health crossed a threshold downwards (warn, critical, liquidatable)
//   recovered it climbed back out, with the rearm gap so a loan hovering on a line doesn't chatter
//   clock     at today's rates the carry eats the headroom in under --days-warn days, even if health looks fine
//   rules     the pool's admin changed something (rate strategy, thresholds, price source) since the last round
import type { Hex } from "viem";
import { readAave } from "./aave.js";
import type { Chain } from "./chain.js";
import { sampleBlocks } from "./clock.js";
import { better, nextLevel, worse, type Level, type Thresholds } from "./health.js";
import { assess, lookAt, type Assessment } from "./look.js";
import { tokenInfo } from "./read.js";
import { alertCard, alertText, hfText, recoveredCard, short, shortKeys, type Card } from "./render.js";
import { isRuleChange, ruleEvents, type RuleEvent } from "./tripwire.js";
import { AAVE_POOLS } from "./venues.js";

export interface WatchState {
  lastBlock?: number;
  levels: Record<string, Level>;
  clockWarned: Record<string, boolean>;
}

export interface Alert {
  kind: "level" | "recovered" | "clock" | "rules";
  key: string;
  block: number;
  text: string;
  /** The same alert laid out for Telegram and Discord. */
  card?: Card;
}

export const emptyState = (): WatchState => ({ levels: {}, clockWarned: {} });

const pct = (x: number) => `${(x * 100).toFixed(2)}%`;
const days = (d: number | null) => (d === null ? "not shrinking" : d > 3650 ? "over 10 years" : `${Math.round(d)} days`);

/** Re-reads one Aave loan at an earlier block, so a rule change can be shown as before vs after. */
export async function aaveLoanAt(chain: Chain, poolAddr: Hex, wallet: Hex, block: number, t: Thresholds, daysWarn: number): Promise<Assessment | null> {
  const p = AAVE_POOLS.find((x) => x.pool.toLowerCase() === poolAddr.toLowerCase());
  if (!p) return null;
  const r = await readAave(chain, p, wallet, block, await sampleBlocks(chain, block));
  if (!r) return null;
  return assess(chain, { snap: r.snap, aave: { wiring: r.wiring, poolKey: p.key } }, t, daysWarn);
}

export async function rulesReport(chain: Chain, events: RuleEvent[], before: Assessment, after: Assessment): Promise<{ text: string; card: Card }> {
  const first = events[0];
  const tx = await chain.tx(first.tx).catch(() => null);
  const who = tx ? `sent by ${short(tx.from)}${tx.to ? ` through ${short(tx.to)}` : ""}` : "";
  const named = await Promise.all(events.filter(isRuleChange).map(async (e) => `${e.name}${e.subject ? ` ${(await tokenInfo(chain, e.subject).catch(() => ({ symbol: short(e.subject!) }))).symbol}` : ""}`));
  const b = before.loan.snap;
  const a = after.loan.snap;
  const rates = a.debt.map((d) => {
    const old = b.debt.find((x) => x.token === d.token);
    return `${d.symbol} borrow ${old ? pct(old.apr) : "?"} -> ${pct(d.apr)}`;
  });
  const lts = a.collateral.filter((c) => c.lt > 0).map((c) => {
    const old = b.collateral.find((x) => x.token === c.token);
    return old && old.lt !== c.lt ? `${c.symbol} liquidation threshold ${old.lt} -> ${c.lt}` : null;
  }).filter(Boolean);
  const against = a.hf < b.hf - 1e-6 || after.clockNow.net < before.clockNow.net - 1e-6;
  const shift = against ? "this works AGAINST the loan" : "this doesn't hurt the loan (yet)";
  const text = [
    `RULES CHANGED on ${a.venue} at block ${first.block} (tx ${short(first.tx)}${who ? `, ${who}` : ""}): ${named.join(", ")}`,
    `for ${short(a.wallet)}: health ${hfText(b.hf)} -> ${hfText(a.hf)}; ${[...rates, ...lts].join("; ")}`,
    `days left at today's rates ${days(before.clockNow.days)} -> ${days(after.clockNow.days)}; if suppliers leave ${days(before.clockStress.days)} -> ${days(after.clockStress.days)}`,
    `${shift}. Who can change these rules: ${after.keys}`,
  ].join("\n");
  // The phone version: one field per question a borrower asks, arrows instead of "->".
  const arrow = (s: string) => s.replace(" -> ", " → ");
  const todo = alertCard(after).fields.find((f) => f.name.startsWith("To get back"));
  const card: Card = {
    tone: "rules",
    title: `🛠 RULES CHANGED · ${a.venue}`,
    lead: `block ${first.block} · tx ${short(first.tx)}${who ? ` · ${who}` : ""}`,
    fields: [
      { name: "What changed", value: named.map((n) => `• ${n}`).join("\n") },
      { name: `For ${short(a.wallet)}`, value: [`health ${hfText(b.hf)} → ${hfText(a.hf)}`, ...rates.map(arrow), ...(lts as string[]).map(arrow)].join("\n") },
      { name: "Days left", value: `at today's rates: ${arrow(`${days(before.clockNow.days)} -> ${days(after.clockNow.days)}`)}\nif suppliers pull their cash: ${arrow(`${days(before.clockStress.days)} -> ${days(after.clockStress.days)}`)}` },
      { name: "Verdict", value: against ? "works AGAINST the loan" : "doesn't hurt the loan (yet)" },
      ...(todo ? [todo] : []),
      { name: "Who can do this", value: shortKeys(after.keys) },
    ],
    footer: `lastcall · Pharos block ${a.block}`,
  };
  return { text, card };
}

/** Health after the change, plus the usual action line, so a rules alert also says what to do. */
function tail(a: Assessment): string {
  return alertText(a).split("\n").filter((l) => l.startsWith("act")).join("\n");
}

export async function watchRound(chain: Chain, wallets: Hex[], t: Thresholds, daysWarn: number, state: WatchState, extraMarkets: Hex[] = []): Promise<{ alerts: Alert[]; look: Awaited<ReturnType<typeof lookAt>> }> {
  const look = await lookAt(chain, wallets, t, daysWarn, undefined, extraMarkets);
  const alerts: Alert[] = [];
  for (const a of look.out) {
    const prev = state.levels[a.key];
    const lvl = nextLevel(prev, a.loan.snap.hf, t);
    if (worse(lvl, prev)) {
      const why = prev ? `${prev} → ${lvl}` : "first look";
      alerts.push({ kind: "level", key: a.key, block: look.block, text: alertText({ ...a, level: lvl }, why.replace("→", "->")), card: alertCard({ ...a, level: lvl }, why) });
    } else if (better(lvl, prev)) {
      alerts.push({ kind: "recovered", key: a.key, block: look.block, text: `RECOVERED ${prev} -> ${lvl}: ${a.loan.snap.venue} ${short(a.loan.snap.wallet)} health ${hfText(a.loan.snap.hf)}. act: nothing needed now.`, card: recoveredCard(a, prev!, lvl) });
    }
    state.levels[a.key] = lvl;
    const short_ = a.clockNow.days !== null && a.clockNow.days < daysWarn;
    if (short_ && !state.clockWarned[a.key] && !alerts.some((x) => x.key === a.key)) {
      alerts.push({ kind: "clock", key: a.key, block: look.block, text: alertText(a, `CLOCK under ${daysWarn} days`), card: alertCard(a, `carry clock under ${daysWarn} days`) });
    }
    state.clockWarned[a.key] = short_;
  }

  // Rule changes since the last round, only for pools somebody we watch actually borrows from.
  const aaveLoans = look.out.filter((a) => a.loan.aave);
  if (state.lastBlock !== undefined && state.lastBlock < look.block && aaveLoans.length) {
    const watched = [...new Set(aaveLoans.flatMap((a) => {
      const w = a.loan.aave!.wiring;
      return [w.configurator, w.provider, w.oracle, ...(w.owner ? [w.owner] : [])].map((x) => x.toLowerCase() as Hex);
    }))];
    const events = await ruleEvents(chain, watched, state.lastBlock + 1, look.block);
    const byTx = new Map<string, RuleEvent[]>();
    for (const e of events) byTx.set(e.tx, [...(byTx.get(e.tx) ?? []), e]);
    for (const [, evs] of byTx) {
      if (!evs.some(isRuleChange)) continue;
      const emitters = new Set(evs.map((e) => e.emitter.toLowerCase()));
      for (const a of aaveLoans) {
        const w = a.loan.aave!.wiring;
        if (![w.configurator, w.provider, w.oracle, w.owner].some((x) => x && emitters.has(x.toLowerCase()))) continue;
        const before = await aaveLoanAt(chain, a.loan.snap.where, a.loan.snap.wallet, evs[0].block - 1, t, daysWarn);
        if (!before) continue;
        const r = await rulesReport(chain, evs, before, a);
        alerts.push({ kind: "rules", key: a.key, block: evs[0].block, text: `${r.text}\n${tail(a)}`, card: r.card });
      }
    }
  }
  state.lastBlock = look.block;
  return { alerts, look };
}

/**
 * What the rules alert would have said for a change that already happened: events in `block` from the pool's
 * admin contracts, the loan one block before and at that block.
 */
export async function replayRules(chain: Chain, poolKey: string, wallet: Hex, block: number, t: Thresholds, daysWarn: number): Promise<{ text: string; card?: Card }> {
  const p = AAVE_POOLS.find((x) => x.key === poolKey);
  if (!p) throw new Error(`unknown pool ${poolKey}; one of ${AAVE_POOLS.map((x) => x.key).join(", ")}`);
  const after = await aaveLoanAt(chain, p.pool, wallet, block, t, daysWarn);
  const before = await aaveLoanAt(chain, p.pool, wallet, block - 1, t, daysWarn);
  if (!after || !before) return { text: `${short(wallet)} had no loan on ${p.name} around block ${block}` };
  const w = after.loan.aave!.wiring;
  const watched = [w.configurator, w.provider, w.oracle, ...(w.owner ? [w.owner] : [])];
  const events = await ruleEvents(chain, watched, block, block);
  if (!events.some(isRuleChange)) return { text: `no rule change from ${p.name}'s admin contracts in block ${block}` };
  const r = await rulesReport(chain, events, before, after);
  return { text: `${r.text}\n${tail(after)}`, card: r.card };
}
