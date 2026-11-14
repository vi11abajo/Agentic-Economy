// Prosperion's server: the API (for the pages), our MCP (for the agent), the launch watcher and the Telegram bot,
// all in one process on loopback. nginx puts /api/ on the internet; the MCP stays on 127.0.0.1 for Hermes only.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { formatEther, getAddress, isAddress, parseAbi, type Address } from "viem";
import { askAgent, chatAgent } from "./agent.js";
import { GATE_ABI, createApi, type GateLimits } from "./api.js";
import { rankBoard, readBoard } from "./board.js";
import { makeNotifier, makeOutbox, type Notifier } from "./notifier.js";
import { readPortfolio } from "./portfolio.js";
import { BOUGHT_TOPIC, LIMITS_SET_TOPIC, decodeGateLog, type BoardSnap, type GateLog } from "./rules.js";
import { openAlertBook } from "./subscriptions.js";

import { client } from "./chain.js";
import { checkMarket } from "./market.js";
import { startMcpHttp } from "./mcpHttp.js";
import { explainNavMove } from "./navmove.js";
import { prepareBuy } from "./prepare.js";
import { chainSellReader, prepareSell, sellQuote } from "./sell.js";
import { gateLimitsView } from "./gateView.js";
import { openStore, type Launch } from "./store.js";
import { listVaults, vaultDetail } from "./prosperApi.js";
import { BOT_COMMANDS, pollTelegram, telegramChannel } from "./telegram.js";
import { readVault } from "./vault.js";
import { LaunchWatcher, rpcWatcherDeps } from "./watcher.js";
import { BUY_TOPIC, SELL_TOPIC, TradeIndexer, openTradeBook, type RawTradeLog } from "./trades.js";

const env = process.env;
const API_PORT = Number(env.PORT ?? 18620);
const MCP_PORT = Number(env.MCP_PORT ?? 18621);
const DB = env.PROSPERION_DB ?? "data/prosperion.db";
const GATE: Address | null = env.PROSPERION_GATE && isAddress(env.PROSPERION_GATE) ? getAddress(env.PROSPERION_GATE) : null;

mkdirSync(dirname(DB), { recursive: true });
const store = openStore(DB);
const alertBook = openAlertBook(store.db);
const BEACON_ABI = parseAbi(["function implementation() view returns (address)"]);

async function readLimits(owner: Address, blockNumber?: bigint): Promise<GateLimits | null> {
  if (!GATE) return null;
  const [maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl] = await client.readContract({
    address: GATE, abi: GATE_ABI, functionName: "limitsOf", args: [owner], blockNumber,
  });
  // all zeros and no market code: never set. Zeros with a code is "Stop all buys", which is not the same thing.
  return maxPerBuy === 0n && /^0x0{40}$/.test(acceptedMarketImpl) ? null : { maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl };
}

async function spentToday(owner: Address, blockNumber?: bigint): Promise<bigint> {
  if (!GATE) return 0n;
  const day = BigInt(Math.floor(Date.now() / 1000 / 86_400)); // the gate's own day: block.timestamp / 1 days
  return client.readContract({ address: GATE, abi: GATE_ABI, functionName: "spentOn", args: [owner, day], blockNumber });
}

/** The gate limits for the agent, every figure from the same block. */
async function gateLimitsFor(owner: Address) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const [limits, spent, implNow] = await Promise.all([readLimits(owner, block), spentToday(owner, block), marketImpl()]);
  const dayEndsAt = (Math.floor(Date.now() / 1000 / 86_400) + 1) * 86_400;
  return gateLimitsView({ block, limits, spent, implNow, dayEndsAt });
}

// The beacon never moves (it is immutable in the gate), so ask once; what it points at is read every time.
let beacon: Address | null = null;
async function marketImpl(): Promise<Address> {
  if (!GATE) throw new Error("no gate");
  beacon ??= await client.readContract({ address: GATE, abi: GATE_ABI, functionName: "marketBeacon" });
  return client.readContract({ address: beacon, abi: BEACON_ABI, functionName: "implementation" });
}

// Each copy of Prosperion brings its own Telegram bot, or none. The username comes from Telegram itself (getMe),
// so the token is the only thing an operator sets. Until it answers, the page treats this copy as bot-less.
let botName: string | null = null;

// one reader for the agent's sell tools and the sign page, so both see the same numbers
const readSell = chainSellReader(client, checkMarket);

const api = createApi({
  readSell,
  store,
  gate: GATE,
  check: checkMarket,
  readLimits,
  spentToday,
  marketImpl,
  readVault,
  listVaults,
  explainNavMove,
  agent: (messages, env, key, signal) => chatAgent(messages, env, key, signal, botName),
  telegramBot: () => botName,
  alerts: alertBook,
  perMinute: Number(env.CHAT_PER_MINUTE ?? 3),
  userDaily: Number(env.USER_DAILY_TURNS ?? 30),
  dailyCap: Number(env.AGENT_DAILY_CAP ?? 300),
  now: () => Math.floor(Date.now() / 1000),
});
createServer(api).listen(API_PORT, "127.0.0.1", () => console.log(`[api] 127.0.0.1:${API_PORT}`));

// Every buy and sell on every Prosper curve, indexed from the first launch on. A fresh database starts an hour before
// the oldest market Prosper lists and catches up at a few windows a second; after that it follows the head.
const book = openTradeBook(store.db);
let notifier: Notifier | null = null;
let marketList: { at: number; markets: Address[] } | null = null;
async function allMarkets(): Promise<Address[]> {
  if (!marketList || Date.now() - marketList.at > 10 * 60_000) {
    const fromApi = await listVaults().then((rows) => rows.map((r) => getAddress(r.market))).catch(() => marketList?.markets ?? []);
    const seen = store.listLaunches(500).map((l) => getAddress(l.market));
    marketList = { at: Date.now(), markets: [...new Set([...fromApi, ...seen])] };
  }
  return marketList.markets;
}
async function blockAtTime(ts: number): Promise<bigint> {
  let lo = 0n, hi = await client.getBlockNumber({ cacheTime: 0 });
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n;
    if (Number((await client.getBlock({ blockNumber: mid })).timestamp) <= ts) lo = mid; else hi = mid - 1n;
  }
  return lo;
}
const indexer = new TradeIndexer(book, {
  head: () => client.getBlockNumber({ cacheTime: 0 }),
  markets: allMarkets,
  getLogs: (markets, from, to) => client.request({
    method: "eth_getLogs",
    params: [{ address: markets, topics: [[BUY_TOPIC, SELL_TOPIC]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
  } as never) as Promise<RawTradeLog[]>,
  startBlock: async () => {
    const first = (await listVaults()).map((r) => Date.parse(r.createdAt)).filter(Number.isFinite).sort((a, b) => a - b)[0];
    return blockAtTime(Math.floor(first / 1000) - 3600);
  },
  onTrades: async (trades) => { await notifier?.onTrades(trades); },
});
void indexer.run((e) => console.error(`[trades] ${e.message}`));

await startMcpHttp({
  listLaunches: (n) => store.listLaunches(n),
  sellQuote: (m, o, a) => sellQuote(readSell, m, o, a),
  prepareSell: (i) => prepareSell(store, readSell, i),
  ...(GATE ? { gateLimits: gateLimitsFor } : {}),
  prepareBuy: (i) => prepareBuy(store, checkMarket, i, { readLimits: (a) => readLimits(a), spentToday }),
  trades: book, head: () => client.getBlockNumber({ cacheTime: 0 }),
}, MCP_PORT);
console.log(`[mcp] 127.0.0.1:${MCP_PORT}/mcp`);

// The quote a launch check makes uses the biggest snipe anyone set, so the number in the alert means something.
const quoteAmount = () => alertBook.recipients("snipe").reduce((m, r) => {
  const w = BigInt(Math.round(Number(r.params.amountPros) * 1e6)) * 10n ** 12n;
  return w > m ? w : m;
}, 10n ** 18n);
const watcher = new LaunchWatcher(rpcWatcherDeps(quoteAmount));
watcher.on("error", (e) => console.error(`[watcher] ${(e as Error).message}`));

// ---- the bot's sources. Each one reads, hands the notifier what it saw, and the notifier decides who hears it.
const every = (ms: number, name: string, f: () => Promise<unknown>) => {
  const run = () => f().catch((e) => console.error(`[${name}] ${(e as Error).message}`)).finally(() => setTimeout(run, ms));
  setTimeout(run, 5_000);
};
let vaultRows: { at: number; rows: Awaited<ReturnType<typeof listVaults>> } | null = null;
const rows = async () => {
  if (!vaultRows || Date.now() - vaultRows.at > 5 * 60_000) vaultRows = { at: Date.now(), rows: await listVaults() };
  return vaultRows.rows;
};
const symbolOf = (m: Address) => vaultRows?.rows.find((r) => r.market.toLowerCase() === m.toLowerCase())?.pVaultSymbol ?? `market ${m.slice(0, 6)}…${m.slice(-4)}`;
const amount = (w: bigint) => Number(formatEther(w)).toLocaleString("en-US", { maximumFractionDigits: 2 });
async function readHoldings(owner: Address) {
  const p = await readPortfolio(owner, await rows());
  return {
    holdings: p.holdings.map((h) => ({
      token: h.token, symbol: h.symbol, kind: h.kind, balance: h.balance, market: h.market,
      value: h.kind === "pToken" ? (h.sellNetPros ?? 0n) : (h.valueUsdc ?? 0n),
      text: h.kind === "pToken"
        ? `${amount(h.balance)} tokens, ${h.sellNetPros == null ? `${h.phase}: trades on FaroSwap` : `a full sell on the curve pays ${amount(h.sellNetPros)} PROS`}`
        : `${amount(h.balance)} shares, worth ${(Number(h.valueUsdc ?? 0n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC`,
    })),
  };
}

const token = env.TELEGRAM_BOT_TOKEN;
if (token) {
  const tg = telegramChannel(token);
  const n = makeNotifier({
    store, book: alertBook, out: makeOutbox((m) => tg.send(m)),
    gate: { readLimits: (a) => readLimits(a), spentToday, limitsAt: (a, b) => readLimits(a, b) },
    curatorOf: async (v) => (await vaultDetail(v)).r25Display?.curator?.address ?? null,
    askAgent: (p) => askAgent(p), agentTimeoutMs: 180_000,
    symbolOf, readHoldings,
  });
  notifier = n;
  watcher.on("launch", (l: Launch) => {
    console.log(`[watcher] launch ${l.market} at ${l.block}`);
    void n.onLaunch(l).catch((e) => console.error(`[alerts] ${(e as Error).message}`));
  });
  // every market at one block, once a minute: progress and phase changes
  every(60_000, "board", async () => {
    const board = await readBoard(await rows());
    const snap: BoardSnap = {};
    for (const e of board.entries) snap[e.market] = { symbol: e.symbol, phase: e.phase, bps: e.progressBps };
    alertBook.setState("boardTop", rankBoard(board.entries, "curve", 5).map((e) => ({ symbol: e.symbol, bps: e.progressBps, hoursLeft: e.hoursLeft })));
    await n.onBoard(snap);
  });
  every(5 * 60_000, "portfolios", () => n.onPortfolios());
  every(5 * 60_000, "digest", () => n.onClock());
  // the gate's own events: LimitsSet and Bought, from where we stopped, 1,000 blocks at a time
  if (GATE) {
    every(15_000, "gate-logs", async () => {
      const head = await client.getBlockNumber({ cacheTime: 0 });
      let from = BigInt(alertBook.getState<string>("gateCursor") ?? (head - 50n).toString()) + 1n;
      while (from <= head) {
        const to = from + 999n < head ? from + 999n : head;
        const logs = (await client.request({
          method: "eth_getLogs",
          params: [{ address: GATE, topics: [[LIMITS_SET_TOPIC, BOUGHT_TOPIC]], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
        } as never)) as GateLog[];
        await n.onGateEvents(logs.map(decodeGateLog).filter((e) => e !== null));
        alertBook.setState("gateCursor", to.toString());
        from = to + 1n;
      }
    });
  }
  tg.api("getMe", {})
    .then((me: { username?: string }) => { botName = me.username ?? null; console.log(`[tg] bot @${botName} polling`); })
    .catch((e) => console.error(`[tg] the token did not work: ${(e as Error).message}`));
  tg.api("setMyCommands", { commands: BOT_COMMANDS }).catch((e) => console.error(`[tg] commands: ${(e as Error).message}`));
  void pollTelegram(store, tg, () => false, alertBook);
} else {
  watcher.on("launch", (l: Launch) => { store.saveLaunch(l); console.log(`[watcher] launch ${l.market} (no bot token, stored only)`); });
  console.log("[tg] TELEGRAM_BOT_TOKEN not set: no bot on this copy, launches are stored and shown, nobody is pinged");
}
watcher.start(1000);
console.log(`[watcher] following Prosper's factory${GATE ? `, gate ${GATE}` : ", gate not deployed yet"}`);
