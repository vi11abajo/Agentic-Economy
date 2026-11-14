// What each kind of alert says, and when it should say nothing. Pure: the pollers hand in what they read, these
// decide. Every alert carries a key; the alert book delivers a key to a wallet once, so a restart or two sources
// seeing the same event cannot double a message.
import { formatEther, getAddress, keccak256, parseEther, toHex, type Address } from "viem";
import { EXPLORER } from "./chain.js";
import { limitsRefusal } from "./prepare.js";
import { SITE } from "./links.js";
import type { GateLimits } from "./api.js";
import type { Launch } from "./store.js";
import type { Subs } from "./subscriptions.js";
import type { Trade } from "./trades.js";

export interface Button { text: string; url?: string; data?: string }
export interface Alert {
  key: string;
  market?: Address;
  /** Telegram HTML */
  text: string;
  buttons?: Button[][];
}

const pros = (w: bigint) => `${Number(formatEther(w)).toLocaleString("en-US", { maximumFractionDigits: 4 })} PROS`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const addr = (a: string) => `<a href="${EXPLORER}/address/${a}">${short(a)}</a>`;
const txl = (h: string, label = "tx") => `<a href="${EXPLORER}/tx/${h}">${label}</a>`;
const marketButtons = (m: Address): Button[][] => [[
  { text: "Follow", data: `follow:${m}` }, { text: "Mute this market", data: `mute:${m}` },
  { text: "Launches", url: `${SITE}/launches/` },
]];

const fresh = (l: Launch) => !!l.checks && l.checks.genuine && l.checks.phase === 0;

/** A new market that passed the checks, unless your filters say otherwise. `curator` comes from Prosper's API. */
export function launchAlert(l: Launch, p: Subs["launch"], curator: string | null): Alert | null {
  if (!fresh(l)) return null;
  const c = l.checks!;
  if (p.maxInCurvePros !== null && c.reserveBefore > parseEther(p.maxInCurvePros)) return null;
  if (curator && p.skipCurators.includes(curator.toLowerCase())) return null;
  return {
    key: `launch:${getAddress(l.market)}`, market: getAddress(l.market),
    text: [
      `<b>New Prosper launch</b>, checked at block ${c.block}`,
      `Market ${addr(l.market)}, token ${addr(l.pToken)}, vault ${addr(l.vault)}`,
      `Listed by Prosper's factory: yes. On the curve: yes. Already in it: ${pros(c.reserveBefore)}${c.reserveBefore === 0n ? " (nobody yet)" : ""}.`,
      curator ? `Curator: ${addr(curator)}` : "",
      `Created in ${txl(l.tx, "this tx")}. The agent's notes follow.`,
    ].filter(Boolean).join("\n"),
    buttons: marketButtons(getAddress(l.market)),
  };
}

export type SnipePlan = { ok: true; amountWei: bigint; maxReserveWei: bigint } | { ok: false; reason: string };

/**
 * Whether to prepare a buy for this wallet. null: the launch is not one you asked for (say nothing). A refusal: it is,
 * but your own gate limits would stop it, so the message says which one instead of carrying a link that would revert.
 * No limits at all is fine: the sign page offers them first.
 */
export function snipePlan(l: Launch, p: Subs["snipe"], gate: { have: GateLimits | null; spent: bigint }): SnipePlan | null {
  if (!fresh(l)) return null;
  const c = l.checks!;
  const maxReserveWei = parseEther(p.maxInCurvePros);
  if (c.reserveBefore > maxReserveWei) return null;
  const amountWei = parseEther(p.amountPros);
  const over = gate.have ? limitsRefusal(gate.have, gate.spent, amountWei, c.reserveBefore, c.implNow) : undefined;
  return over ? { ok: false, reason: over } : { ok: true, amountWei, maxReserveWei };
}

export function snipeText(l: Launch, amountWei: bigint, url: string, hasLimits: boolean): string {
  const c = l.checks!;
  return [
    `<b>Snipe ready: ${pros(amountWei)} into a new Prosper launch</b>`,
    `Market ${addr(l.market)}, checked at block ${c.block}: listed by Prosper's factory, on the curve, ${pros(c.reserveBefore)} in it.`,
    "",
    `Your buy is prepared for your wallet: ${url}`,
    hasLimits
      ? "Open it in your wallet (buttons below, or scan the QR), press Connect and sign once."
      : "Your wallet has no limits on the gate yet, so the page asks you to sign them first, then the buy.",
    "The page checks the market again right before your wallet opens; if someone got in first, it says so and offers nothing.",
  ].join("\n");
}

export interface BoardSnap { [market: string]: { symbol: string; phase: number; bps: number } }
export interface ProgressEvent { key: string; market: Address; text: string }

/** Thresholds crossed and phases changed between two looks at the board. A market new to the board is a baseline. */
export function progressEvents(prev: BoardSnap | undefined, cur: BoardSnap, thresholds: number[]): ProgressEvent[] {
  if (!prev) return [];
  const out: ProgressEvent[] = [];
  for (const [m, now] of Object.entries(cur)) {
    const was = prev[m];
    if (!was) continue;
    const market = getAddress(m);
    if (was.phase !== now.phase) {
      const [head, tail] = now.phase === 2 ? ["graduated", "it now trades on FaroSwap"]
        : now.phase === 3 ? ["failed", "its window closed short of the target"] : [`moved to phase ${now.phase}`, ""];
      out.push({ key: `phase:${market}:${now.phase}`, market, text: `<b>${now.symbol} ${head}</b>${tail ? `: ${tail}` : ""}. Market ${addr(market)}.` });
      continue;
    }
    if (now.phase !== 0) continue;
    for (const t of thresholds) {
      if (was.bps < t * 100 && now.bps >= t * 100) {
        out.push({ key: `progress:${market}:${t}`, market,
          text: `<b>${now.symbol} crossed ${t}%</b> of its 20,000 PROS target (now ${(now.bps / 100).toFixed(1)}%). Market ${addr(market)}.` });
      }
    }
  }
  return out;
}

export function whaleAlert(t: Trade, minWei: bigint, symbol: string): Alert | null {
  if (t.prosGross < minWei) return null;
  const verb = t.kind === "buy" ? "bought in with" : "sold out for";
  return {
    key: `trade:${t.tx}:${t.logIndex}`, market: t.market,
    text: `<b>${symbol}: ${short(t.trader)} ${t.kind === "buy" ? "bought" : "sold"}</b>, ${verb} ${pros(t.prosGross)} at block ${t.block}. ${txl(t.tx)} · market ${addr(t.market)}`,
    buttons: marketButtons(t.market),
  };
}

export interface HoldingValue { token: Address; symbol: string; kind: "pToken" | "vault shares"; balance: bigint; value: bigint }
export interface PositionBase { [token: string]: { balance: string; value: string } }

/**
 * Moves per unit since the last alert (or since we first saw the holding). The baseline only moves when an alert goes
 * out, so ten 1% drifts still add up to one alert. A different balance means you bought or sold: new baseline, quietly.
 */
export function positionMoves(base: PositionBase, holdings: HoldingValue[], movePct: number, navMovePct: number) {
  const next: PositionBase = {};
  const alerts: Alert[] = [];
  for (const h of holdings) {
    const b = base[h.token];
    const fresh = { balance: h.balance.toString(), value: h.value.toString() };
    if (!b || BigInt(b.balance) !== h.balance || BigInt(b.value) === 0n) { next[h.token] = fresh; continue; }
    const was = BigInt(b.value);
    const pct = (Number(h.value - was) / Number(was)) * 100;
    const limit = h.kind === "pToken" ? movePct : navMovePct;
    if (Math.abs(pct) < limit) { next[h.token] = b; continue; }
    next[h.token] = fresh;
    const worth = h.kind === "pToken" ? `a full sell on the curve pays ${pros(h.value)}` : `worth ${(Number(h.value) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC at the vault's price`;
    alerts.push({
      key: `position:${h.token}:${h.value}`,
      text: `<b>${h.symbol} ${pct > 0 ? "up" : "down"} ${Math.abs(Math.round(pct))}%</b> since the last alert: ${worth}.`,
    });
  }
  return { alerts, base: next };
}

export const LIMITS_SET_TOPIC = keccak256(toHex("LimitsSet(address,(uint128,uint128,uint128,address))"));
export const BOUGHT_TOPIC = keccak256(toHex("Bought(address,address,uint256,uint256)"));
export interface GateLog { topics: string[]; data: string; transactionHash: string; logIndex: string; blockNumber: string }
export type GateEvent =
  | { kind: "limits"; user: Address; tx: string; logIndex: number; block: bigint; limits: GateLimits }
  | { kind: "bought"; user: Address; tx: string; logIndex: number; block: bigint; market: Address; value: bigint; out: bigint };

export function decodeGateLog(l: GateLog): GateEvent | null {
  const word = (i: number) => BigInt(`0x${l.data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
  const user = getAddress(`0x${l.topics[1].slice(26)}`);
  const base = { user, tx: l.transactionHash, logIndex: Number(l.logIndex), block: BigInt(l.blockNumber) };
  if (l.topics[0] === LIMITS_SET_TOPIC) {
    return { kind: "limits", ...base, limits: { maxPerBuy: word(0), maxPerDay: word(1), maxReserveBefore: word(2), acceptedMarketImpl: getAddress(`0x${word(3).toString(16).padStart(40, "0")}`) } };
  }
  if (l.topics[0] === BOUGHT_TOPIC) {
    return { kind: "bought", ...base, market: getAddress(`0x${l.topics[2].slice(26)}`), value: word(0), out: word(1) };
  }
  return null;
}

export function gateAlert(e: GateEvent): Alert {
  const key = `gate:${e.tx}:${e.logIndex}`;
  if (e.kind === "bought") {
    return { key, market: e.market, text: `<b>Your wallet bought through the Prosperion gate</b>: ${pros(e.value)} into ${addr(e.market)} for ${(Number(e.out) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 2 })} tokens, block ${e.block}. ${txl(e.tx)}` };
  }
  const l = e.limits;
  const now = l.maxPerBuy === 0n
    ? "every buy is stopped"
    : `${pros(l.maxPerBuy).replace(" PROS", " PROS per buy")}, ${pros(l.maxPerDay).replace(" PROS", " PROS a day")}, only while at most ${pros(l.maxReserveBefore)} is in the curve`;
  return {
    key,
    text: `<b>Your gate limits changed</b> at block ${e.block}: ${now}. ${txl(e.tx)}\nIf this was not you, your wallet's key is in someone else's hands: press Stop all buys on ${SITE}/launches/ and move your funds.`,
  };
}

export function digestText(date: string, holdings: { symbol: string; kind: string; text: string }[], top: { symbol: string; bps: number; hoursLeft: number }[]): string {
  return [
    `<b>Prosperion, ${date}</b>`,
    holdings.length ? "What you hold:" : "You hold nothing in Prosper right now.",
    ...holdings.map((h) => `· ${h.symbol} (${h.kind}): ${h.text}`),
    "",
    top.length ? "Closest to graduating:" : "No launch is open on the curve.",
    ...top.map((t) => `· ${t.symbol}: ${(t.bps / 100).toFixed(1)}% of 20,000 PROS, ${t.hoursLeft > 0 ? `${Math.round(t.hoursLeft)} h left` : "window closed"}`),
  ].join("\n");
}
