// Prosperion's server: the API (for the pages), our MCP (for the agent), the launch watcher and the Telegram bot,
// all in one process on loopback. nginx puts /api/ on the internet; the MCP stays on 127.0.0.1 for Hermes only.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, parseAbi, type Address } from "viem";
import { askAgent, chatAgent } from "./agent.js";
import { onLaunch } from "./alerts.js";
import { GATE_ABI, createApi, type GateLimits } from "./api.js";
import { client } from "./chain.js";
import { checkMarket } from "./market.js";
import { startMcpHttp } from "./mcpHttp.js";
import { explainNavMove } from "./navmove.js";
import { prepareBuy } from "./prepare.js";
import { openStore, type Launch } from "./store.js";
import { listVaults } from "./prosperApi.js";
import { pollTelegram, telegramChannel } from "./telegram.js";
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
const BEACON_ABI = parseAbi(["function implementation() view returns (address)"]);

async function readLimits(owner: Address): Promise<GateLimits | null> {
  if (!GATE) return null;
  const [maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl] = await client.readContract({
    address: GATE, abi: GATE_ABI, functionName: "limitsOf", args: [owner],
  });
  // all zeros and no market code: never set. Zeros with a code is "Stop all buys", which is not the same thing.
  return maxPerBuy === 0n && /^0x0{40}$/.test(acceptedMarketImpl) ? null : { maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl };
}

async function spentToday(owner: Address): Promise<bigint> {
  if (!GATE) return 0n;
  const day = BigInt(Math.floor(Date.now() / 1000 / 86_400)); // the gate's own day: block.timestamp / 1 days
  return client.readContract({ address: GATE, abi: GATE_ABI, functionName: "spentOn", args: [owner, day] });
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

const api = createApi({
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
  perMinute: Number(env.CHAT_PER_MINUTE ?? 3),
  userDaily: Number(env.USER_DAILY_TURNS ?? 30),
  dailyCap: Number(env.AGENT_DAILY_CAP ?? 300),
  now: () => Math.floor(Date.now() / 1000),
});
createServer(api).listen(API_PORT, "127.0.0.1", () => console.log(`[api] 127.0.0.1:${API_PORT}`));

// Every buy and sell on every Prosper curve, indexed from the first launch on. A fresh database starts an hour before
// the oldest market Prosper lists and catches up at a few windows a second; after that it follows the head.
const book = openTradeBook(store.db);
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
});
void indexer.run((e) => console.error(`[trades] ${e.message}`));

await startMcpHttp({
  listLaunches: (n) => store.listLaunches(n), prepareBuy: (i) => prepareBuy(store, checkMarket, i, { readLimits, spentToday }),
  trades: book, head: () => client.getBlockNumber({ cacheTime: 0 }),
}, MCP_PORT);
console.log(`[mcp] 127.0.0.1:${MCP_PORT}/mcp`);

// The quote in an alert uses the biggest per-buy limit anyone set, so the number means something.
const quoteAmount = () => store.allWatches().reduce((m, w) => (w.maxPerBuyWei > m ? w.maxPerBuyWei : m), 10n ** 18n);
const watcher = new LaunchWatcher(rpcWatcherDeps(quoteAmount));
watcher.on("error", (e) => console.error(`[watcher] ${(e as Error).message}`));

const token = env.TELEGRAM_BOT_TOKEN;
if (token) {
  const tg = telegramChannel(token);
  watcher.on("launch", (l: Launch) => {
    console.log(`[watcher] launch ${l.market} at ${l.block}`);
    void onLaunch(l, store, { telegram: tg, askAgent: (p) => askAgent(p), agentTimeoutMs: 180_000 })
      .catch((e) => console.error(`[alerts] ${(e as Error).message}`));
  });
  tg.api("getMe", {})
    .then((me: { username?: string }) => { botName = me.username ?? null; console.log(`[tg] bot @${botName} polling`); })
    .catch((e) => console.error(`[tg] the token did not work: ${(e as Error).message}`));
  void pollTelegram(store, tg, () => false);
} else {
  watcher.on("launch", (l: Launch) => { store.saveLaunch(l); console.log(`[watcher] launch ${l.market} (no bot token, stored only)`); });
  console.log("[tg] TELEGRAM_BOT_TOKEN not set: no bot on this copy, launches are stored and shown, nobody is pinged");
}
watcher.start(1000);
console.log(`[watcher] following Prosper's factory${GATE ? `, gate ${GATE}` : ", gate not deployed yet"}`);
