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

// One look for every alert: an icon and a headline that already says the news, a blank line, short "label: value"
// lines with the numbers that matter in bold, then links by name (never a bare 66-character hash) and, last, a hint.
const num = (x: number, d = 4) => x.toLocaleString("en-US", { maximumFractionDigits: d });
const pros = (w: bigint) => `${num(Number(formatEther(w)))} PROS`;
const tokens = (w: bigint) => num(Number(formatEther(w)), 0);
const short = (x: string) => `${x.slice(0, 6)}…${x.slice(-4)}`;
const esc = (x: string) => x.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const a = (href: string, label: string) => `<a href="${href}">${label}</a>`;
const addr = (x: string) => a(`${EXPLORER}/address/${x}`, short(x));
const blk = (b: bigint) => a(`${EXPLORER}/block/${b}`, `#${num(Number(b), 0)}`);
const links = (...l: [string, string][]) => `🔗 ${l.map(([label, href]) => a(href, label)).join(" · ")}`;
const card = (head: string, rows: (string | false | null | undefined)[], ...tail: (string | false)[]) =>
  [head, "", ...rows.filter(Boolean), ...(tail.some(Boolean) ? ["", ...tail.filter(Boolean)] : [])].join("\n");
const notYou = `⚠️ Not you? Your wallet's key is in someone else's hands. Press ${a(`${SITE}/launches/`, "Stop all buys")} and move your funds.`;
const marketButtons = (m: Address): Button[][] => [[
  { text: "Follow", data: `follow:${m}` }, { text: "Mute this market", data: `mute:${m}` },
  { text: "Launches", url: `${SITE}/launches/` },
]];
const TARGET = 20_000;

const fresh = (l: Launch) => !!l.checks && l.checks.genuine && l.checks.phase === 0;

/** A new market that passed the checks, unless your filters say otherwise. `curator` comes from Prosper's API. */
export function launchAlert(l: Launch, p: Subs["launch"], curator: string | null, symbol?: string): Alert | null {
  if (!fresh(l)) return null;
  const c = l.checks!;
  if (p.maxInCurvePros !== null && c.reserveBefore > parseEther(p.maxInCurvePros)) return null;
  if (curator && p.skipCurators.includes(curator.toLowerCase())) return null;
  return {
    key: `launch:${getAddress(l.market)}`, market: getAddress(l.market),
    text: card(`🚀 <b>New Prosper launch${symbol ? `: ${esc(symbol)}` : ""}</b>`, [
      `In the curve: <b>${pros(c.reserveBefore)}</b>${c.reserveBefore === 0n ? ", nobody has bought yet" : ""}`,
      `To graduate: ${num(TARGET)} PROS`,
      `Checked at ${blk(c.block)}: listed by Prosper's factory, on the curve`,
      curator && `Curator: ${addr(curator)}`,
      links(["Market", `${EXPLORER}/address/${l.market}`], ["Token", `${EXPLORER}/address/${l.pToken}`], ["Vault", `${EXPLORER}/address/${l.vault}`], ["Creation tx", `${EXPLORER}/tx/${l.tx}`]),
    ], "<i>The agent's notes follow as a reply.</i>"),
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

export function snipeText(l: Launch, amountWei: bigint, owner: Address, hasLimits: boolean, symbol?: string): string {
  const c = l.checks!;
  return card(`🎯 <b>Snipe ready: ${pros(amountWei)} into ${symbol ? esc(symbol) : "a new launch"}</b>`, [
    `For: ${addr(owner)} (your wallet)`,
    `In the curve now: <b>${pros(c.reserveBefore)}</b>, checked at ${blk(c.block)}`,
    links(["Market", `${EXPLORER}/address/${l.market}`], ["Creation tx", `${EXPLORER}/tx/${l.tx}`]),
  ],
  hasLimits
    ? "👉 Tap your wallet below or scan the QR, then Connect and sign once."
    : "👉 Tap your wallet below or scan the QR. Your gate has no limits yet: the page asks you to sign them first (no PROS moves), then the buy.",
  "<i>The page checks again before your wallet opens. If someone got in first, it stops and offers nothing.</i>");
}

export function snipeSkipped(l: Launch, reason: string, symbol?: string): string {
  return card(`⛔ <b>Snipe skipped: ${symbol ? esc(symbol) : short(l.market)}</b>`, [
    `Why: ${esc(reason)}`,
    links(["Market", `${EXPLORER}/address/${l.market}`], ["Your buy limits", `${SITE}/launches/#limits`]),
  ]);
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
    const sym = esc(now.symbol);
    const where = links(["Market", `${EXPLORER}/address/${market}`], ["Launches", `${SITE}/launches/`]);
    if (was.phase !== now.phase) {
      const text = now.phase === 2 ? card(`🎓 <b>${sym} graduated</b>`, ["It reached 20,000 PROS and now trades on FaroSwap. Ask the agent for its pool price.", where])
        : now.phase === 3 ? card(`❌ <b>${sym} failed</b>`, ["Its window closed short of 20,000 PROS.", where])
        : card(`🔄 <b>${sym} moved to phase ${now.phase}</b>`, [where]);
      out.push({ key: `phase:${market}:${now.phase}`, market, text });
      continue;
    }
    if (now.phase !== 0) continue;
    for (const t of thresholds) {
      if (was.bps < t * 100 && now.bps >= t * 100) {
        const inCurve = (now.bps * TARGET) / 10_000;
        out.push({ key: `progress:${market}:${t}`, market, text: card(`📈 <b>${sym} passed ${t}% of its target</b>`, [
          `In the curve: <b>${num(inCurve, 0)} of ${num(TARGET)} PROS</b> (${(now.bps / 100).toFixed(1)}%)`,
          `Left to graduate: about ${num(TARGET - inCurve, 0)} PROS`,
          where,
        ]) });
      }
    }
  }
  return out;
}

export function whaleAlert(t: Trade, minWei: bigint, symbol: string): Alert | null {
  if (t.prosGross < minWei) return null;
  const buy = t.kind === "buy";
  return {
    key: `trade:${t.tx}:${t.logIndex}`, market: t.market,
    text: card(`🐋 <b>${esc(symbol)}: ${buy ? "buy" : "sell"} of ${pros(t.prosGross)}</b>`, [
      `${buy ? "Buyer" : "Seller"}: ${addr(t.trader)}`,
      `Tokens ${buy ? "bought" : "sold"}: <b>${tokens(t.tokens)}</b>`,
      `${buy ? "Reached the curve" : "Paid out"}: ${pros(t.prosNet)} after the ${pros(t.fee)} fee`,
      `Block: ${blk(t.block)}`,
      links(["Tx", `${EXPLORER}/tx/${t.tx}`], ["Market", `${EXPLORER}/address/${t.market}`]),
    ]),
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
    const usdc = (v: bigint) => `${num(Number(v) / 1e6, 2)} USDC`;
    alerts.push({
      key: `position:${h.token}:${h.value}`,
      text: card(`${pct > 0 ? "📈" : "📉"} <b>${esc(h.symbol)} ${pct > 0 ? "up" : "down"} ${Math.abs(Math.round(pct))}%</b> since the last alert`, [
        h.kind === "pToken"
          ? `A full sell on the curve pays: <b>${pros(h.value)}</b> (was ${pros(was)})`
          : `Worth at the vault's price: <b>${usdc(h.value)}</b> (was ${usdc(was)})`,
        `You hold: ${tokens(h.balance)} ${h.kind === "pToken" ? "tokens" : "shares"}`,
      ]),
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

/** `before`: the limits one block earlier, so the message can say what changed. `symbol`: the market's, for a buy. */
export function gateAlert(e: GateEvent, before?: GateLimits | null, symbol?: string): Alert {
  const key = `gate:${e.tx}:${e.logIndex}`;
  const where = `Block: ${blk(e.block)} · ${a(`${EXPLORER}/tx/${e.tx}`, "Tx")}`;
  if (e.kind === "bought") {
    return { key, market: e.market, text: card(`🛒 <b>Bought through the gate: ${pros(e.value)} into ${symbol ? esc(symbol) : short(e.market)}</b>`, [
      `Wallet: ${addr(e.user)}`,
      `Got: <b>${tokens(e.out)} tokens</b>`,
      `${where} · ${a(`${EXPLORER}/address/${e.market}`, "Market")}`,
    ], notYou) };
  }
  const l = e.limits;
  const was = (now: bigint, then: bigint | undefined) => (before && then !== undefined && then !== now ? ` (was ${pros(then).replace(" PROS", "")})` : "");
  const stopped = l.maxPerBuy === 0n;
  return {
    key,
    text: card(`🔐 <b>${stopped ? "All buys stopped on your gate" : "Your gate limits changed"}</b>`, [
      `Wallet: ${addr(e.user)}`,
      ...(stopped ? ["Every buy from this wallet is refused until you save new limits."] : [
        `Per buy: <b>${pros(l.maxPerBuy)}</b>${was(l.maxPerBuy, before?.maxPerBuy)}`,
        `Per day: <b>${pros(l.maxPerDay)}</b>${was(l.maxPerDay, before?.maxPerDay)}`,
        `Most PROS already in the curve: <b>${pros(l.maxReserveBefore)}</b>${was(l.maxReserveBefore, before?.maxReserveBefore)}`,
      ]),
      where,
    ], notYou),
  };
}

export function digestText(date: string, holdings: { symbol: string; kind: string; text: string }[], top: { symbol: string; bps: number; hoursLeft: number }[]): string {
  const day = new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return card(`☀️ <b>Prosperion daily, ${day}</b>`, [
    "<b>You hold</b>",
    ...(holdings.length ? holdings.map((h) => `• ${esc(h.symbol)}: ${h.text}`) : ["Nothing in Prosper right now."]),
    "",
    "<b>Closest to graduating</b>",
    ...(top.length
      ? top.map((t, i) => `${i + 1}. ${esc(t.symbol)}: ${(t.bps / 100).toFixed(1)}% of ${num(TARGET)} PROS, ${t.hoursLeft > 0 ? `${Math.round(t.hoursLeft)} h left` : "window closed"}`)
      : ["No launch is open on the curve."]),
    "",
    links(["Launches", `${SITE}/launches/`], ["Alert settings", `${SITE}/alerts/`]),
  ]);
}
