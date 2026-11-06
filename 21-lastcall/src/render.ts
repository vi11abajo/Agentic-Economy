// Words. Everything a person reads comes out of here, so the numbers are formatted in one place and the console,
// Telegram and Discord all say the same thing.
import type { Advice, Assessment } from "./look.js";
import { movingCollateral, type Clock, type Leg, type Snapshot } from "./health.js";

export const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function amount(raw: bigint, decimals: number, maxFrac = 4): string {
  const n = Number(raw) / 10 ** decimals;
  const frac = n >= 1000 ? 2 : n >= 1 ? Math.min(maxFrac, 4) : 6;
  return n.toLocaleString("en-US", { maximumFractionDigits: frac });
}

const money = (v: number, quote: string) => (quote === "USD" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `${v.toLocaleString("en-US", { maximumFractionDigits: 2 })} ${quote}`);
const pct = (x: number, d = 2) => `${(x * 100).toFixed(d)}%`;
export const hfText = (h: number) => (Number.isFinite(h) ? h.toFixed(4) : "no debt");

const legs = (xs: Leg[]) => xs.map((l) => `${amount(l.amount, l.decimals)} ${l.symbol}`).join(" + ");

export function stamp(t = new Date()): string {
  return `[${t.toISOString()}]`;
}

export function headline(a: Assessment): string {
  const s = a.loan.snap;
  return `${a.level.toUpperCase()} ${s.venue} ${short(s.wallet)}: health ${hfText(s.hf)} (debt ${legs(s.debt)}, collateral ${legs(s.collateral)})`;
}

export function priceLine(a: Assessment): string {
  const s = a.loan.snap;
  const owedTokens = new Set(s.debt.map((d) => d.token.toLowerCase()));
  const steady = s.collateral.filter((c) => c.lt > 0 && c.priceShape !== "moving" && !owedTokens.has(c.token.toLowerCase()));
  const parts: string[] = [];
  if (a.drop !== null) {
    const moving = movingCollateral(s).map((c) => c.symbol).join("/");
    parts.push(a.drop >= 1 ? `even if ${moving} went to zero the rest of the collateral still covers the debt` : `liquidated if ${moving} falls ${pct(a.drop, 1)} further`);
  }
  const hedged = s.collateral.filter((c) => c.lt > 0 && owedTokens.has(c.token.toLowerCase()));
  if (hedged.length) parts.push(`${hedged.map((c) => c.symbol).join("/")} is posted against a ${hedged.map((c) => c.symbol).join("/")} loan, its price cancels out`);
  for (const c of steady) {
    parts.push(c.priceShape === "flat"
      ? `${c.symbol} oracle didn't move in 7 days`
      : `${c.symbol} oracle only climbed in 7 days (${pct(c.trendApr)}/yr, NAV-style), so a price drop isn't the risk here`);
  }
  return parts.join("; ");
}

function clockText(c: Clock): string {
  if (c.days === null) return `health is growing on its own (collateral ${pct(c.collateralGrowth)}/yr vs debt ${pct(c.debtGrowth)}/yr)`;
  if (c.days === 0) return "already past the line";
  const when = c.days > 3650 ? "more than 10 years" : `about ${Math.round(c.days)} days`;
  return `health shrinks ${pct(-c.net)}/yr (collateral ${pct(c.collateralGrowth)} vs debt ${pct(c.debtGrowth)}), ${when} to liquidation if nothing else moves`;
}

export function clockLines(a: Assessment): string[] {
  const out = [`carry now: ${clockText(a.clockNow)}`];
  const stressed = a.loan.snap.debt.some((d) => d.stressApr !== undefined && d.stressApr !== d.apr);
  if (stressed) out.push(`carry if every spare unit of supply left the market (borrow ${pct(a.clockStress.debtGrowth)}): ${clockText(a.clockStress)}`);
  return out;
}

function adviceText(x: Advice, s: Snapshot): string {
  const what = `${x.move.kind === "repay" ? "repay" : "add"} ${amount(x.move.amount, x.move.leg.decimals)} ${x.move.leg.symbol}${x.move.kind === "add" ? " collateral" : ""}`;
  const r = x.rehearsal;
  const has = `you hold ${amount(r.walletHas, x.move.leg.decimals)} ${x.move.leg.symbol}${r.walletHas >= x.move.amount ? ", enough" : ""}`;
  if (!r.ok) return `${what} (expected health ${hfText(x.move.expectedHf)}; rehearsal failed: ${r.why}; ${has})`;
  return `${what} -> health ${hfText(r.hfAfter!)} (rehearsed on the real ${s.kind === "aave" ? "pool" : "Morpho contract"} at block ${s.block}; ${has})`;
}

export function actionLine(a: Assessment): string {
  const s = a.loan.snap;
  if (a.advice.length === 0) return `act: nothing needed, health is above ${a.aim.toFixed(2)}`;
  const why = a.aim > 1.5000001 && a.clockNow.days !== null ? ` (aiming at ${a.aim.toFixed(3)} because the carry shrinks health)` : ` to get back to ${a.aim.toFixed(2)}`;
  return `act${why}: ${a.advice.map((x) => adviceText(x, s)).join("  OR  ")}`;
}

/** The full alert, one line per idea. */
export function alertText(a: Assessment, reason?: string): string {
  return [
    `${reason ? `${reason}: ` : ""}${headline(a)}`,
    priceLine(a),
    ...clockLines(a),
    actionLine(a),
    `rules: ${a.keys}`,
  ].filter(Boolean).join("\n");
}

export function table(rows: Assessment[]): string {
  const head = "# | venue | wallet | health | level | price risk | days left (now / stress) | debt";
  const lines = rows.map((a, i) => {
    const s = a.loan.snap;
    const days = (c: Clock) => (c.days === null ? "growing" : c.days > 3650 ? ">10y" : `${Math.round(c.days)}`);
    const risk = a.drop === null ? "no price risk" : a.drop >= 1 ? "covered" : `-${pct(a.drop, 1)}`;
    return `${i + 1} | ${s.venue} | ${short(s.wallet)} | ${hfText(s.hf)} | ${a.level} | ${risk} | ${days(a.clockNow)} / ${days(a.clockStress)} | ${money(s.debt.reduce((x, d) => x + d.value, 0), s.quote)}`;
  });
  return [head, ...lines].join("\n");
}

// ---- Cards: the same alert, laid out for a phone screen (Discord embeds, Telegram HTML) ----

export interface Card {
  /** Sets the colour stripe in Discord and the icon in the title. */
  tone: "liquidatable" | "critical" | "warn" | "ok" | "rules";
  title: string;
  lead: string;
  fields: { name: string; value: string }[];
  footer: string;
}

const ICON: Record<Card["tone"], string> = { liquidatable: "🟥", critical: "🔴", warn: "🟠", ok: "🟢", rules: "🛠" };
export const TONE_COLOR: Record<Card["tone"], number> = { liquidatable: 0x7f1d1d, critical: 0xdc2626, warn: 0xf59e0b, ok: 0x059669, rules: 0x1e2bfa };

const days = (c: Clock) => (c.days === null ? "not shrinking" : c.days === 0 ? "past the line" : c.days > 3650 ? "over 10 years" : `about ${Math.round(c.days)} days`);

/** "Safe 0xc6f5…84f4 · 3 of 5 signers · no timelock" instead of the long sentence. */
export function shortKeys(keys: string): string {
  if (keys.startsWith("fixed")) return "fixed: the market id is the hash of its terms, nobody can change them";
  const safe = keys.match(/Safe (0x[0-9a-fA-F]{40}), (\d+) of (\d+) signers/);
  if (safe) return `can change: Safe ${short(safe[1])}, ${safe[2]} of ${safe[3]} signers, no timelock`;
  const tl = keys.match(/timelock (0x[0-9a-fA-F]{40}), (.*)/);
  if (tl) return `can change: timelock ${short(tl[1])}, ${tl[2]}`;
  const any = keys.match(/(0x[0-9a-fA-F]{40})/);
  return any ? `can change: ${short(any[1])} (not a Safe or a timelock)` : keys;
}

function priceShort(a: Assessment): string {
  const s = a.loan.snap;
  const owedTokens = new Set(s.debt.map((d) => d.token.toLowerCase()));
  const out: string[] = [];
  if (a.drop !== null) {
    const moving = movingCollateral(s).map((c) => c.symbol).join("/");
    out.push(a.drop >= 1 ? `${moving} could go to zero, the rest still covers the debt` : `${moving} can fall ${pct(a.drop, 1)} more before liquidation`);
  }
  for (const c of s.collateral.filter((x) => x.lt > 0 && owedTokens.has(x.token.toLowerCase()))) out.push(`${c.symbol} against a ${c.symbol} loan cancels out`);
  for (const c of s.collateral.filter((x) => x.lt > 0 && x.priceShape !== "moving" && !owedTokens.has(x.token.toLowerCase()))) {
    out.push(c.priceShape === "flat" ? `${c.symbol} oracle flat for 7 days` : `none: ${c.symbol} oracle only climbed this week (+${pct(c.trendApr)}/yr)`);
  }
  return out.join("\n") || "n/a";
}

function timeShort(a: Assessment): string {
  const n = a.clockNow;
  const lines = [n.days === null
    ? `now: health grows (earns ${pct(n.collateralGrowth)}, costs ${pct(n.debtGrowth)})`
    : `now: ${days(n)} (earns ${pct(n.collateralGrowth)}, costs ${pct(n.debtGrowth)})`];
  if (a.loan.snap.debt.some((d) => d.stressApr !== undefined && d.stressApr !== d.apr)) {
    lines.push(`if suppliers pull their cash (borrow ${pct(a.clockStress.debtGrowth)}): ${days(a.clockStress)}`);
  }
  return lines.join("\n");
}

function todoShort(a: Assessment): string {
  if (a.advice.length === 0) return `nothing for now, health is above ${a.aim.toFixed(2)}`;
  const s = a.loan.snap;
  const lines = a.advice.map((x, i) => {
    const what = `${i === 0 ? "" : "or "}${x.move.kind === "repay" ? "repay" : "add"} ${amount(x.move.amount, x.move.leg.decimals)} ${x.move.leg.symbol}`;
    return x.rehearsal.ok ? `• ${what} → health ${hfText(x.rehearsal.hfAfter!)}` : `• ${what} → about ${hfText(x.move.expectedHf)} (rehearsal failed)`;
  });
  const held = a.advice.map((x) => `${amount(x.rehearsal.walletHas, x.move.leg.decimals)} ${x.move.leg.symbol}`).join(" / ");
  const ok = a.advice.every((x) => x.rehearsal.ok);
  lines.push(`${ok ? "both tried on the real " + (s.kind === "aave" ? "pool" : "Morpho contract") + " first" : "arithmetic only where the rehearsal failed"}; wallet holds ${held}`);
  return lines.join("\n");
}

export function alertCard(a: Assessment, reason?: string): Card {
  const s = a.loan.snap;
  return {
    tone: a.level,
    title: `${ICON[a.level]} ${a.level.toUpperCase()} · ${s.venue}`,
    lead: `${short(s.wallet)} · health ${hfText(s.hf)} (liquidation at 1.0)${reason ? ` · ${reason}` : ""}`,
    fields: [
      { name: "Loan", value: `owes ${legs(s.debt)}\nagainst ${legs(s.collateral)}` },
      { name: "Price risk", value: priceShort(a) },
      { name: "Time left", value: timeShort(a) },
      { name: `To get back to ${a.aim.toFixed(2)}`, value: todoShort(a) },
      { name: "Rules", value: shortKeys(a.keys) },
    ],
    footer: `lastcall · Pharos block ${s.block}`,
  };
}

export function recoveredCard(a: Assessment, from: string, to: string): Card {
  const s = a.loan.snap;
  return {
    tone: "ok",
    title: `${ICON.ok} RECOVERED · ${s.venue}`,
    lead: `${short(s.wallet)} · health ${hfText(s.hf)}, ${from} → ${to}`,
    fields: [{ name: "To do", value: "nothing needed now" }],
    footer: `lastcall · Pharos block ${s.block}`,
  };
}

const escHtml = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function cardHtml(c: Card, when: string): string {
  return [
    `<b>${escHtml(c.title)}</b>`,
    escHtml(c.lead),
    ...c.fields.map((f) => `\n<b>${escHtml(f.name)}</b>\n${escHtml(f.value)}`),
    `\n<i>${escHtml(c.footer)} · ${escHtml(when)}</i>`,
  ].join("\n");
}

export function cardEmbed(c: Card, when: Date): object {
  return {
    title: c.title,
    description: c.lead,
    color: TONE_COLOR[c.tone],
    fields: c.fields.map((f) => ({ name: f.name, value: f.value.slice(0, 1024), inline: false })),
    footer: { text: c.footer },
    timestamp: when.toISOString(),
  };
}
