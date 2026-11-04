// The seven rules. Each one looks at the same Situation (the policy, the clock, the facts read from the trace)
// and says pass or fail with a reason a person can act on. judge() runs them in a fixed order and stops at the
// first "no": that rule decided, and the reason says exactly what to change if the user wants it through.
import { formatUnits, maxUint256, type Address } from "viem";
import { DAYS, type Policy } from "./policy.js";
import type { Facts, Hop } from "./trace.js";

export type RuleId = "policy" | "time_window" | "simulation" | "contracts" | "recipients" | "approvals" | "spend.per_tx" | "spend.per_day";
export type Check = { rule: RuleId; ok: boolean; reason: string; hop?: Hop };
export type Situation = {
  policy: Policy;
  now: Date;
  facts: Facts;
  hasCode: (a: Address) => boolean;
  /** PROS the tx itself carries (the trace counts nothing from a frame that failed, so it's passed separately). */
  value: bigint;
  balance: bigint;
  /** gas limit x max fee: the most this tx can burn on gas */
  worstGas: bigint;
  /** what the audit log says already left today, per spend key; or why the log can't be trusted */
  spentToday: Map<string, bigint> | { broken: string };
};
export type Judgement = { decision: "allow" | "deny"; rule: RuleId | null; reason: string; checks: Check[] };

const pass = (rule: RuleId, reason: string): Check => ({ rule, ok: true, reason });
const fail = (rule: RuleId, reason: string, hop?: Hop): Check => ({ rule, ok: false, reason, ...(hop ? { hop } : {}) });
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
const pros = (n: bigint) => `${formatUnits(n, 18)} PROS`;
export const describePath = (hop: Hop) => hop.path.map((a, i) => (i === 0 ? "wallet" : short(a))).join(" -> ");

export function checkTimeWindow(s: Situation): Check {
  const w = s.policy.timeWindow;
  if (!w) return pass("time_window", "no window set");
  const minute = s.now.getUTCHours() * 60 + s.now.getUTCMinutes();
  const today = s.now.getUTCDay();
  const window = `${w.days.join(",")} ${hhmm(w.from)}-${hhmm(w.to)} UTC`;
  // A window that wraps midnight belongs to the day it opened: Friday 22:00-02:00 still covers 01:00 Saturday.
  let day: number | null = null;
  if (w.from < w.to) day = minute >= w.from && minute < w.to ? today : null;
  else day = minute >= w.from ? today : minute < w.to ? (today + 6) % 7 : null;
  const now = `${DAYS[today]} ${hhmm(minute)} UTC`;
  if (day === null || !w.days.includes(DAYS[day])) return fail("time_window", `it's ${now}, outside the allowed window ${window}`);
  return pass("time_window", `${now} is inside ${window}`);
}

export function checkSimulation(s: Situation): Check {
  if (s.facts.reverted) return fail("simulation", `the transaction would fail on chain anyway: ${s.facts.reverted.reason}`);
  if (s.value + s.worstGas > s.balance) return fail("simulation", `the wallet holds ${pros(s.balance)}, but this needs ${pros(s.value)} plus up to ${pros(s.worstGas)} for gas`);
  return pass("simulation", `runs fine on mainnet state; gas up to ${pros(s.worstGas)}`);
}

export function checkContracts(s: Situation): Check {
  const listed = new Set(s.policy.contracts);
  const touched = s.facts.hops.filter((h) => h.type.startsWith("CREATE") || s.hasCode(h.address));
  for (const hop of touched) {
    if (hop.type.startsWith("CREATE")) return fail("contracts", `it creates a new contract (${hop.address}); a new address can't be on the list. Path: ${describePath(hop)}`, hop);
    if (!listed.has(hop.address)) {
      // Name the first one with its path, and the rest too: the user decides about all of them at once.
      const others = [...new Set(touched.filter((h) => !listed.has(h.address) && h.address !== hop.address).map((h) => h.address))];
      const more = others.length ? `; ${others.length} more not on the list: ${others.join(", ")}` : "";
      return fail("contracts", `${hop.address} isn't on the contracts list; the transaction reaches it at depth ${hop.depth}: ${describePath(hop)}${more}`, hop);
    }
  }
  return pass("contracts", touched.length ? `all ${new Set(touched.map((h) => h.address)).size} contracts it calls are listed` : "calls no contract");
}

export function checkRecipients(s: Situation): Check {
  const ok = new Set<Address>([s.policy.wallet, ...s.policy.recipients, ...s.policy.contracts]);
  for (const p of s.facts.prosTo)
    if (!s.hasCode(p.to) && !ok.has(p.to)) return fail("recipients", `${pros(p.amount)} would go to ${p.to}, which isn't on the recipients list`, p.hop);
  for (const t of s.facts.tokenTo) if (!ok.has(t.to)) return fail("recipients", `token ${t.token} would go to ${t.to}, which isn't on the recipients list`);
  const n = s.facts.prosTo.length + s.facts.tokenTo.length;
  return pass("recipients", n ? "everyone who receives something is allowed" : "sends nothing to anyone");
}

export function checkApprovals(s: Situation): Check {
  const spenders = new Set(s.policy.approvals.spenders);
  for (const a of s.facts.approvals) {
    if (!spenders.has(a.spender)) return fail("approvals", `it would let ${a.spender} spend the wallet's ${a.token}, and that spender isn't on the approvals list`);
    const unlimited = a.kind === "forall" || (a.kind === "erc20" && a.amount === maxUint256);
    if (unlimited && !s.policy.approvals.unlimited) return fail("approvals", `it would give ${a.spender} an unlimited approval on ${a.token}; the policy doesn't allow unlimited approvals`);
  }
  return pass("approvals", s.facts.approvals.length ? "approvals are to listed spenders" : "approves nothing");
}

/** Every asset leaving the wallet as [spend key or null, raw amount, label], PROS first. */
function outgoing(s: Situation): Array<{ key: string | null; amount: bigint; label: string }> {
  const out: Array<{ key: string | null; amount: bigint; label: string }> = [];
  if (s.facts.prosOut > 0n) out.push({ key: s.policy.spend.PROS ? "PROS" : null, amount: s.facts.prosOut, label: "PROS" });
  for (const [token, amount] of s.facts.tokensOut) {
    const key = Object.keys(s.policy.spend).find((k) => s.policy.spend[k].token === token) ?? null;
    out.push({ key, amount, label: key ?? token });
  }
  return out;
}
const fmt = (s: Situation, key: string, n: bigint) => `${formatUnits(n, s.policy.spend[key].decimals)} ${key}`;

export function checkSpendPerTx(s: Situation): Check {
  const out = outgoing(s);
  for (const o of out) {
    if (!o.key) return fail("spend.per_tx", `no limit set for ${o.label}, so none of it may leave the wallet`);
    const cap = s.policy.spend[o.key].perTx;
    if (o.amount > cap) return fail("spend.per_tx", `${fmt(s, o.key, o.amount)} in one go is over the per-transaction cap of ${fmt(s, o.key, cap)}`);
  }
  return pass("spend.per_tx", out.length ? out.map((o) => `${fmt(s, o.key!, o.amount)} of ${fmt(s, o.key!, s.policy.spend[o.key!].perTx)}`).join(", ") : "spends nothing");
}

export function checkSpendPerDay(s: Situation): Check {
  const out = outgoing(s);
  if (!out.length) return pass("spend.per_day", "spends nothing");
  if (!(s.spentToday instanceof Map)) return fail("spend.per_day", `can't tell what was already spent today: ${s.spentToday.broken}`);
  const today = s.spentToday;
  for (const o of out) {
    if (!o.key) return fail("spend.per_day", `no limit set for ${o.label}`);
    const before = today.get(o.key) ?? 0n;
    const cap = s.policy.spend[o.key].perDay;
    if (before + o.amount > cap)
      return fail("spend.per_day", `${fmt(s, o.key, before)} already sent in the last 24 h + ${fmt(s, o.key, o.amount)} now = ${fmt(s, o.key, before + o.amount)}, over the daily cap of ${fmt(s, o.key, cap)}`);
  }
  return pass("spend.per_day", out.map((o) => `${fmt(s, o.key!, (today.get(o.key!) ?? 0n) + o.amount)} of ${fmt(s, o.key!, s.policy.spend[o.key!].perDay)} today`).join(", "));
}

const ORDER = [checkTimeWindow, checkSimulation, checkContracts, checkRecipients, checkApprovals, checkSpendPerTx, checkSpendPerDay];

export function judge(s: Situation): Judgement {
  const checks: Check[] = [];
  for (const rule of ORDER) {
    const c = rule(s);
    checks.push(c);
    if (!c.ok) return { decision: "deny", rule: c.rule, reason: c.reason, checks };
  }
  return { decision: "allow", rule: null, reason: "every rule passed", checks };
}
