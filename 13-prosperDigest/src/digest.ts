// One digest run: pick the period, read it from the chain (and the period before, when history doesn't have
// it), build the digest, save it, and send it to each enabled channel that hasn't received it yet.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { blockAtTime, type Chain } from "./chain.js";
import { DeliveryError, redact, RETRY_DELAYS_MS, sendDiscord, sendTelegram, withRetry, type Net } from "./deliver.js";
import { pickEvents } from "./events.js";
import { computeMetrics } from "./metrics.js";
import { currentPeriod, dueAt, lastClosedPeriod, previousPeriod, type Period } from "./period.js";
import { GRADUATED, ON_CURVE, SCAN_START, type Market, type Trade } from "./prosper.js";
import { discordPayload, htmlReport, markdownReport, reportName, telegramText } from "./render.js";
import { extendRegistry, readRange, saveRegistry, type Registry } from "./scan.js";
import { loadConfig, log, putHistory, readEnv, readHistory, type Secrets } from "./store.js";
import { trends } from "./trends.js";
import type { Digest, Metrics, TokenStat } from "./types.js";

export interface RunDeps {
  chain: Chain;
  home: string;
  net: Net;
  now: () => number; // unix seconds
  sleep: (ms: number) => Promise<void>;
  progress?: (line: string) => void;
  scanStart?: number;
}

type Channel = "telegram" | "discord";
export type SendState = "sent" | "skipped" | "failed" | "already";
export interface RunResult {
  period: string;
  built: boolean;
  sent: Record<Channel, SendState>;
  notes: string[];
}

interface PeriodRead {
  metrics: Metrics;
  tokens: TokenStat[];
  trades: Trade[];
  created: Market[];
  graduated: Market[];
  startBlock: number;
  endBlock: number;
}

/** Phase at the period's end for every market that existed, and at its start where it may have changed. */
async function phases(chain: Chain, reg: Registry, startBlock: number, endBlock: number) {
  const out: Record<string, { start: number | null; end: number | null }> = {};
  for (const m of Object.values(reg.markets)) {
    if (m.createdBlock > endBlock) continue;
    const known = m.finalPhase !== undefined && (m.finalAt ?? Infinity) <= endBlock;
    const end = known ? m.finalPhase! : await chain.phase(m.market, endBlock);
    let start: number | null = end;
    if (end !== ON_CURVE) {
      const finalBefore = m.finalPhase !== undefined && (m.finalAt ?? Infinity) <= startBlock;
      start = m.createdBlock > startBlock ? null : finalBefore ? m.finalPhase! : await chain.phase(m.market, startBlock);
    }
    if ((end === GRADUATED || end === 3) && (m.finalAt === undefined || endBlock < m.finalAt)) {
      m.finalPhase = end;
      m.finalAt = endBlock;
    }
    out[m.market] = { start, end };
  }
  return out;
}

async function readPeriod(d: RunDeps, p: Period, head: number, partial = false): Promise<PeriodRead> {
  const say = (s: string) => d.progress?.(s);
  const headTime = await d.chain.blockTime(head);
  // A closed period is only read once the chain is past its end, or the digest would miss its last blocks.
  if (!partial && p.end > headTime) throw new Error(`the chain has not reached the end of ${p.key} yet (head ${head} at ${new Date(headTime * 1000).toISOString()}); the catch-up will retry`);
  const startBlock = await blockAtTime(d.chain, p.start, head);
  const endBlock = p.end > headTime ? head : (await blockAtTime(d.chain, p.end, head)) - 1;
  say(`${p.key}: blocks ${startBlock}-${endBlock}`);
  let reg = await extendRegistry(d.chain, d.home, startBlock - 1, d.scanStart ?? SCAN_START, (to, target) => say(`catching up markets: block ${to} of ${target}`));
  const { trades, created } = await readRange(d.chain, reg, startBlock, endBlock, (n, total) => {
    if (n % 100 === 0 || n === total) say(`${p.key}: read ${n}/${total} windows`);
  });
  const ph = await phases(d.chain, reg, startBlock, endBlock);
  saveRegistry(d.home, reg);
  const { metrics, tokens } = computeMetrics({ trades, created, traders: reg.traders, startBlock, endBlock, phases: ph });
  const graduated = Object.entries(ph).filter(([, v]) => v.end === GRADUATED && v.start !== GRADUATED).map(([m]) => reg.markets[m]);
  return { metrics, tokens, trades, created, graduated, startBlock, endBlock };
}

export async function buildDigest(d: RunDeps, p: Period, topTokens = 20, partial = false): Promise<Digest> {
  const head = await d.chain.head();
  const history = readHistory(d.home);
  const prevKey = previousPeriod(p).key;
  let prev = history.find((h) => h.key === prevKey)?.metrics;
  if (!prev) {
    d.progress?.(`no digest for ${prevKey} in history: reading it from the chain too`);
    prev = (await readPeriod(d, previousPeriod(p), head)).metrics;
  }
  const r = await readPeriod(d, p, head, partial);
  const ev = pickEvents({ trades: r.trades, tokens: r.tokens, created: r.created, graduated: r.graduated, days: p.days });
  const earlier = history.filter((h) => h.end <= p.start).sort((a, b) => a.start - b.start);
  const old = history.find((h) => h.key === p.key);
  return {
    key: p.key,
    label: p.label,
    days: p.days,
    start: p.start,
    end: p.end,
    startBlock: r.startBlock,
    endBlock: r.endBlock,
    readAt: d.now(),
    metrics: r.metrics,
    prev,
    tokens: r.tokens.slice(0, topTokens),
    topTrades: [...r.trades].sort((a, b) => b.pros - a.pros).slice(0, 10).map((t) => ({ symbol: t.symbol, side: t.side, pros: t.pros, trader: t.trader, tx: t.tx })),
    newMarkets: r.created.map((m) => m.symbol),
    graduated: r.graduated.map((m) => m.symbol),
    events: ev.top,
    candidates: ev.candidates,
    trends: trends(earlier, r.metrics, p.days),
    delivered: old?.delivered ?? {},
    failed: old?.failed,
  };
}

function saveReports(home: string, dg: Digest): string {
  const dir = join(home, "reports");
  mkdirSync(dir, { recursive: true });
  const html = htmlReport(dg);
  writeFileSync(join(dir, `${reportName(dg)}.html`), html);
  writeFileSync(join(dir, `${reportName(dg)}.md`), markdownReport(dg));
  return html;
}

async function send(d: RunDeps, ch: Channel, s: Secrets, dg: Digest, html: string, note: (s: string) => void): Promise<void> {
  const file = { name: `${reportName(dg)}.html`, body: html };
  const retry = { delaysMs: RETRY_DELAYS_MS, sleep: d.sleep };
  // Discord previews an attached text file as raw code, so it gets the embeds only; the HTML report stays in reports/.
  if (ch === "discord") return withRetry(() => sendDiscord(d.net, s.discordWebhook!, discordPayload(dg)), retry);
  // Telegram takes two calls. The summary is retried on its own; once it is out, only the file is retried, and a
  // file that never goes through doesn't make the summary go out again: the digest reached the user.
  await withRetry(() => sendTelegram(d.net, s, telegramText(dg)), retry);
  try {
    await withRetry(() => sendTelegram(d.net, s, null, file), retry);
  } catch (e) {
    note(`${dg.key}: telegram summary sent, but the report file failed: ${(e as Error).message}`);
  }
}

const ready = (ch: Channel, s: Secrets) => (ch === "telegram" ? !!(s.telegramToken && s.telegramChatId) : !!s.discordWebhook);

export async function run(d: RunDeps, o: { catchUp?: boolean; dry?: boolean; resend?: boolean; period?: "last" | "current" }): Promise<RunResult> {
  const cfg = loadConfig(d.home);
  const secrets = readEnv(d.home);
  const now = d.now();
  const current = o.period === "current";
  const p = current ? currentPeriod(now, cfg.schedule) : lastClosedPeriod(now, cfg.schedule);
  const enabled = (["telegram", "discord"] as Channel[]).filter((c) => cfg.channels[c]);
  const res: RunResult = { period: p.key, built: false, sent: { telegram: "skipped", discord: "skipped" }, notes: [] };
  const note = (s: string) => {
    res.notes.push(s);
    log(d.home, s);
  };

  // Earlier digests whose send failed go out first; they are already built, so nothing is read for them.
  if (!o.dry) {
    for (const old of readHistory(d.home).filter((h) => h.key !== p.key).sort((a, b) => a.start - b.start)) {
      for (const ch of enabled) {
        if (old.delivered[ch] || !old.failed?.[ch] || !ready(ch, secrets)) continue;
        await deliverOne(d, ch, secrets, old, saveReports(d.home, old), note);
      }
    }
  }

  if (o.catchUp && !current && now < dueAt(p, cfg.schedule)) {
    note(`${p.key}: not due yet (due ${new Date(dueAt(p, cfg.schedule) * 1000).toISOString()})`);
    return res;
  }

  const have = current ? undefined : readHistory(d.home).find((h) => h.key === p.key);
  const pending = enabled.filter((ch) => o.resend || !have?.delivered[ch]);
  for (const ch of enabled) if (!pending.includes(ch)) res.sent[ch] = "already";
  if (!o.dry && have && !pending.length) {
    note(`${p.key}: already delivered to ${enabled.join(" and ") || "no channel"}`);
    return res;
  }

  let dg: Digest;
  try {
    dg = have && !o.dry ? have : await buildDigest(d, p, cfg.topTokens, current);
  } catch (e) {
    // Scheduled runs have no console: run.log is where a failed build shows up.
    note(`${p.key}: build failed: ${redact((e as Error).message, secrets)}`);
    throw e;
  }
  res.built = !(have && !o.dry);
  const html = saveReports(d.home, dg);
  if (!current) putHistory(d.home, dg);
  if (res.built) note(`${p.key}: built (${dg.metrics.trades} trades, blocks ${dg.startBlock}-${dg.endBlock})`);
  if (o.dry) return res;

  for (const ch of pending) {
    if (!ready(ch, secrets)) {
      res.sent[ch] = "failed";
      note(`${p.key}: ${ch} is enabled but its line in .env is empty`);
      continue;
    }
    res.sent[ch] = await deliverOne(d, ch, secrets, dg, html, note, !current);
  }
  return res;
}

async function deliverOne(d: RunDeps, ch: Channel, s: Secrets, dg: Digest, html: string, note: (s: string) => void, record = true): Promise<SendState> {
  const at = new Date(d.now() * 1000).toISOString();
  try {
    await send(d, ch, s, dg, html, note);
    if (record) {
      dg.delivered = { ...dg.delivered, [ch]: at };
      if (dg.failed) delete dg.failed[ch];
      putHistory(d.home, dg);
    }
    note(`${dg.key}: sent to ${ch}`);
    return "sent";
  } catch (e) {
    if (record) {
      dg.failed = { ...dg.failed, [ch]: at };
      putHistory(d.home, dg);
    }
    note(`${dg.key}: ${ch} failed: ${(e as Error).message}${e instanceof DeliveryError ? ` (${e.hint})` : ""}`);
    return "failed";
  }
}
