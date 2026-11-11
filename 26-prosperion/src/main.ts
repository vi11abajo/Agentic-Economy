// Prosperion's server: the API (for the pages), our MCP (for the agent), the launch watcher and the Telegram bot,
// all in one process on loopback. nginx puts /api/ on the internet; the MCP stays on 127.0.0.1 for Hermes only.
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { getAddress, isAddress, type Address } from "viem";
import { askAgent, chatAgent } from "./agent.js";
import { onLaunch } from "./alerts.js";
import { GATE_ABI, createApi, type GateLimits } from "./api.js";
import { client } from "./chain.js";
import { checkMarket } from "./market.js";
import { startMcpHttp } from "./mcpHttp.js";
import { explainNavMove } from "./navmove.js";
import { openStore, type Launch } from "./store.js";
import { pollTelegram, telegramChannel } from "./telegram.js";
import { readVault } from "./vault.js";
import { LaunchWatcher, rpcWatcherDeps } from "./watcher.js";

const env = process.env;
const API_PORT = Number(env.PORT ?? 18620);
const MCP_PORT = Number(env.MCP_PORT ?? 18621);
const DB = env.PROSPERION_DB ?? "data/prosperion.db";
const GATE: Address | null = env.PROSPERION_GATE && isAddress(env.PROSPERION_GATE) ? getAddress(env.PROSPERION_GATE) : null;

mkdirSync(dirname(DB), { recursive: true });
const store = openStore(DB);

async function readLimits(owner: Address): Promise<GateLimits | null> {
  if (!GATE) return null;
  const [maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl] = await client.readContract({
    address: GATE, abi: GATE_ABI, functionName: "limitsOf", args: [owner],
  });
  return maxPerBuy === 0n ? null : { maxPerBuy, maxPerDay, maxReserveBefore, acceptedMarketImpl };
}

const api = createApi({
  store,
  gate: GATE,
  check: checkMarket,
  readLimits,
  readVault,
  explainNavMove,
  agent: chatAgent,
  perMinute: Number(env.CHAT_PER_MINUTE ?? 20),
  dailyCap: Number(env.AGENT_DAILY_CAP ?? 300),
  now: () => Math.floor(Date.now() / 1000),
});
createServer(api).listen(API_PORT, "127.0.0.1", () => console.log(`[api] 127.0.0.1:${API_PORT}`));

await startMcpHttp({ listLaunches: (n) => store.listLaunches(n) }, MCP_PORT);
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
  void pollTelegram(store, tg, () => false);
  console.log("[tg] bot polling");
} else {
  watcher.on("launch", (l: Launch) => { store.saveLaunch(l); console.log(`[watcher] launch ${l.market} (no bot token, stored only)`); });
  console.log("[tg] TELEGRAM_BOT_TOKEN not set: launches are stored, nobody is pinged");
}
watcher.start(1000);
console.log(`[watcher] following Prosper's factory${GATE ? `, gate ${GATE}` : ", gate not deployed yet"}`);
