// The bot's engine: sources hand in what they read (a launch, the board, new trades, portfolios, gate logs, the
// clock), the rules decide, and this routes each alert to the wallets that asked for it. Every delivery goes through
// one door: muted market? already sent? then into an outbox that paces each chat and waits out Telegram's 429s.
import { getAddress, type Address } from "viem";
import { requestUrl } from "./links.js";
import { MIN_OUT_BPS } from "./prepare.js";
import {
  launchAlert, snipePlan, snipeText, snipeSkipped, progressEvents, whaleAlert, positionMoves, gateAlert, digestText,
  type Alert, type Button, type BoardSnap, type GateEvent, type HoldingValue, type PositionBase,
} from "./rules.js";
import type { GateLimits } from "./api.js";
import type { Launch, Store } from "./store.js";
import type { AlertBook, Recipient, Scope } from "./subscriptions.js";
import type { Trade } from "./trades.js";

export interface OutMessage { chatId: number; html: string; buttons?: Button[][]; replyTo?: number; sign?: { url: string } }
/** Sends one message, returns its id. Throws with Telegram's own description on failure. */
export type SendFn = (m: OutMessage) => Promise<number>;

/**
 * One queue per chat, one message at a time, a gap between them (Telegram allows about one a second per chat).
 * "Too Many Requests: retry after N" is waited out and retried; anything else is logged and dropped.
 */
export function makeOutbox(send: SendFn, opts: { gapMs?: number; tries?: number; sleep?: (ms: number) => Promise<void> } = {}) {
  const gap = opts.gapMs ?? 1100, tries = opts.tries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const lanes = new Map<number, Promise<unknown>>();
  return (m: OutMessage): Promise<number | null> => {
    const run = async () => {
      for (let i = 1; ; i++) {
        try { return await send(m); }
        catch (e) {
          const wait = /retry after (\d+)/i.exec((e as Error).message)?.[1];
          if (wait && i < tries) { await sleep(Number(wait) * 1000 + 250); continue; }
          console.error(`[notify] to ${m.chatId} failed: ${(e as Error).message}`);
          return null;
        }
      }
    };
    const prev = lanes.get(m.chatId) ?? Promise.resolve();
    const next = prev.then(run).finally(() => sleep(gap));
    const lane = next.then(() => undefined, () => undefined);
    lanes.set(m.chatId, lane);
    void lane.then(() => { if (lanes.get(m.chatId) === lane) lanes.delete(m.chatId); });
    return next;
  };
}

export interface NotifierDeps {
  store: Store;
  book: AlertBook;
  out: (m: OutMessage) => Promise<number | null>;
  gate: {
    readLimits: (a: Address) => Promise<GateLimits | null>;
    spentToday: (a: Address) => Promise<bigint>;
    /** the limits as they were at a past block, so a change can say what it was before */
    limitsAt?: (a: Address, block: bigint) => Promise<GateLimits | null>;
  };
  curatorOf: (vault: Address) => Promise<string | null>;
  askAgent: (prompt: string) => Promise<string>;
  agentTimeoutMs: number;
  symbolOf: (market: Address) => string;
  readHoldings: (owner: Address) => Promise<{ holdings: (HoldingValue & { market: Address; text: string })[] }>;
  now?: () => number;
}

export function dossierPrompt(l: Launch): string {
  return [
    `A new Prosper market was just created: market ${l.market}, vault ${l.vault}, pToken ${l.pToken}, block ${l.block}.`,
    "Write a short dossier for someone deciding whether to buy in first:",
    "who runs the vault and what is behind its NAV (vault_picture), whether the market is genuine and how much PROS is",
    "already in (market_check), and anything that should make them hesitate. Quote the block for every number.",
    "Plain text, under 900 characters. Do not tell them to buy; give facts and risks.",
  ].join(" ");
}

const withTimeout = <T>(p: Promise<T>, ms: number) => new Promise<T>((resolve, reject) => {
  const t = setTimeout(() => reject(new Error("agent took too long")), ms);
  p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
});

export function makeNotifier(d: NotifierDeps) {
  const now = d.now ?? Date.now;

  /** The one door: a muted market or an event this wallet already got goes nowhere. */
  async function deliver(r: { address: Address; chatId: number }, a: Alert, extra: Partial<OutMessage> = {}): Promise<number | null> {
    if (a.market && d.book.isMuted(r.address, a.market, now())) return null;
    if (!d.book.claim(r.address, a.key, now())) return null;
    return d.out({ chatId: r.chatId, html: a.text, buttons: a.buttons, ...extra });
  }

  /** "mine": markets this wallet held at the last portfolio read, plus the ones it follows. */
  const mine = (a: Address) => new Set([...(d.book.getState<string[]>(`held:${a}`) ?? []), ...d.book.follows(a)].map((m) => m.toLowerCase()));
  const inScope = (r: Recipient, scope: Scope, market: string) => scope === "all" || mine(r.address).has(market.toLowerCase());

  return {
    deliver,

    /** A new market: facts to launch subscribers, a prepared buy to snipers, then one agent dossier as a reply. */
    async onLaunch(l: Launch) {
      d.store.saveLaunch(l);
      const sent: { chatId: number; id: number }[] = [];
      const sym = d.symbolOf(getAddress(l.market));
      const launchers = d.book.recipients("launch", now());
      if (launchers.length) {
        const curator = await d.curatorOf(l.vault).catch(() => null);
        for (const r of launchers) {
          const a = launchAlert(l, r.params, curator, sym);
          const id = a && (await deliver(r, a));
          if (id) sent.push({ chatId: r.chatId, id });
        }
      }
      for (const r of d.book.recipients("snipe", now())) {
        const [have, spent] = await Promise.all([d.gate.readLimits(r.address), d.gate.spentToday(r.address)]);
        const plan = snipePlan(l, r.params, { have, spent });
        if (!plan) continue;
        const key = `snipe:${getAddress(l.market)}`;
        if (!plan.ok) {
          await deliver(r, { key, market: l.market, text: snipeSkipped(l, plan.reason, sym) });
          continue;
        }
        const reqId = d.store.saveRequest({
          kind: "buy", createdBlock: l.checks!.block,
          params: {
            market: getAddress(l.market), amountWei: plan.amountWei.toString(), minOutBps: MIN_OUT_BPS,
            maxReserveBeforeWei: plan.maxReserveWei.toString(), acceptedImpl: l.checks!.implNow, owner: r.address, source: "alert",
          },
        });
        const url = requestUrl(reqId);
        const id = await deliver(r, { key, market: l.market, text: snipeText(l, plan.amountWei, r.address, !!have, sym) }, { sign: { url } });
        if (id) sent.push({ chatId: r.chatId, id });
      }
      if (!sent.length) return;
      let dossier: string;
      try {
        dossier = await withTimeout(d.askAgent(dossierPrompt(l)), d.agentTimeoutMs);
        d.store.logDecision({ at: now(), kind: "verdict", subject: l.market, reason: dossier, block: l.checks?.block ?? null });
      } catch (e) {
        dossier = `Agent unavailable right now (${(e as Error).message}). The facts above were read from the chain at block ${l.checks?.block}.`;
      }
      const esc = dossier.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      for (const s of sent) await d.out({ chatId: s.chatId, html: `🤖 <b>Agent's notes</b>\n<blockquote>${esc}</blockquote>`, replyTo: s.id });
    },

    /** A fresh look at every market. Progress and phase changes go to progress subscribers (their scope and
     * thresholds) and phase changes also to anyone holding that market who watches positions. */
    async onBoard(snap: BoardSnap) {
      const prev = d.book.getState<BoardSnap>("board") ?? undefined;
      d.book.setState("board", snap);
      const events = progressEvents(prev, snap, [25, 50, 75, 90]);
      if (!events.length) return;
      for (const r of d.book.recipients("progress", now())) {
        for (const e of events) {
          if (!inScope(r, r.params.scope, e.market)) continue;
          const isPhase = e.key.startsWith("phase:");
          if (isPhase ? !r.params.phase : !r.params.thresholds.includes(Number(e.key.split(":")[2]))) continue;
          await deliver(r, { key: e.key, market: e.market, text: e.text });
        }
      }
      for (const r of d.book.recipients("positions", now())) {
        const held = new Set((d.book.getState<string[]>(`held:${r.address}`) ?? []).map((m) => m.toLowerCase()));
        for (const e of events) if (e.key.startsWith("phase:") && held.has(e.market.toLowerCase())) await deliver(r, { key: e.key, market: e.market, text: e.text });
      }
    },

    /** New curve trades near the head. */
    async onTrades(trades: Trade[]) {
      if (!trades.length) return;
      for (const r of d.book.recipients("whales", now())) {
        const min = BigInt(Math.round(Number(r.params.minPros) * 1e6)) * 10n ** 12n;
        for (const t of trades) {
          if (!inScope(r, r.params.scope, t.market)) continue;
          const a = whaleAlert(t, min, d.symbolOf(t.market));
          if (a) await deliver(r, a);
        }
      }
    },

    /** Who holds what: refreshes the "mine" sets, and alerts positions subscribers on moves. */
    async onPortfolios() {
      const wanted = new Map<Address, Recipient | undefined>();
      for (const k of ["progress", "whales"] as const) for (const r of d.book.recipients(k, now())) if (r.params.scope === "mine") wanted.set(r.address, wanted.get(r.address));
      for (const r of d.book.recipients("positions", now())) wanted.set(r.address, r);
      for (const [address, pos] of wanted) {
        const { holdings } = await d.readHoldings(address);
        d.book.setState(`held:${address}`, [...new Set(holdings.map((h) => h.market))]);
        if (!pos) continue;
        const p = pos.params as { movePct: number; navMovePct: number };
        const base = d.book.getState<PositionBase>(`pos:${address}`) ?? {};
        const moved = positionMoves(base, holdings, p.movePct, p.navMovePct);
        d.book.setState(`pos:${address}`, moved.base);
        for (const a of moved.alerts) await deliver(pos, a);
      }
    },

    /** The gate's LimitsSet and Bought for subscribed wallets. */
    async onGateEvents(events: GateEvent[]) {
      if (!events.length) return;
      const byAddress = new Map(d.book.recipients("security", now()).map((r) => [r.address.toLowerCase(), r]));
      for (const e of events) {
        const r = byAddress.get(e.user.toLowerCase());
        if (!r) continue;
        const before = e.kind === "limits" && d.gate.limitsAt ? await d.gate.limitsAt(r.address, e.block - 1n).catch(() => null) : null;
        await deliver(r, gateAlert(e, before, e.kind === "bought" ? d.symbolOf(e.market) : undefined));
      }
    },

    /** Called every few minutes; whoever's hour it is gets today's digest, once. */
    async onClock() {
      const t = new Date(now());
      const date = t.toISOString().slice(0, 10);
      const due = d.book.recipients("digest", now()).filter((r) => r.params.hourUtc === t.getUTCHours());
      if (!due.length) return;
      const top = d.book.getState<{ symbol: string; bps: number; hoursLeft: number }[]>("boardTop") ?? [];
      for (const r of due) {
        const { holdings } = await d.readHoldings(r.address);
        await deliver(r, { key: `digest:${date}`, text: digestText(date, holdings.map((h) => ({ symbol: h.symbol, kind: h.kind, text: h.text })), top) });
      }
    },
  };
}
export type Notifier = ReturnType<typeof makeNotifier>;
