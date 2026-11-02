// Walks the chain in 1000-block windows and keeps what has to be known before a period can be read: every Prosper
// market (markets.json) and every trader's first trade block (traders.json). Activity of a period is read the
// same way, right when the report is built.
import type { Chain } from "./chain.js";
import { BOUGHT, decodeMarketCreated, decodeTrade, MARKET_CREATED, PROSPER_FACTORY, SCAN_START, SOLD, type Market, type RpcLog, type Trade } from "./prosper.js";
import { readJson, writeJson } from "./store.js";

export const WINDOW = 1000;
export const PREFETCH = 6;

export interface Registry {
  markets: Record<string, Market>;
  traders: Record<string, number>;
  scannedTo: number; // last block covered; start - 1 before any scan
}

export const emptyRegistry = (start = SCAN_START): Registry => ({ markets: {}, traders: {}, scannedTo: start - 1 });

export function loadRegistry(home: string, start = SCAN_START): Registry {
  const m = readJson<{ markets: Record<string, Market>; scannedTo: number } | null>(home, "markets.json", null);
  const t = readJson<Record<string, number>>(home, "traders.json", {});
  return m ? { markets: m.markets, scannedTo: m.scannedTo, traders: t } : emptyRegistry(start);
}

export function saveRegistry(home: string, reg: Registry): void {
  writeJson(home, "traders.json", reg.traders);
  writeJson(home, "markets.json", { markets: reg.markets, scannedTo: reg.scannedTo });
}

const factory = PROSPER_FACTORY.toLowerCase();

/** Reads [from, to]: new markets go into the registry, trades of known markets are returned. */
export async function readRange(
  chain: Chain,
  reg: Registry,
  from: number,
  to: number,
  onWindow?: (done: number, total: number) => void | Promise<void>,
): Promise<{ trades: Trade[]; created: Market[] }> {
  const trades: Trade[] = [];
  const created: Market[] = [];
  const total = Math.ceil((to - from + 1) / WINDOW);
  // A get_logs answer takes ~2.4 s while the MCP allows ~2 calls/s, so a few windows are asked for at once (the
  // MCP client paces them); they are still processed one by one in chain order.
  const ahead: Array<Promise<RpcLog[]>> = [];
  const ask = (k: number) => {
    const a = from + k * WINDOW;
    if (a > to) return;
    const p = chain.logs(a, Math.min(to, a + WINDOW - 1));
    p.catch(() => {}); // a failure surfaces when this window's turn comes, not as an unhandled rejection
    ahead.push(p);
  };
  for (let k = 0; k < PREFETCH; k++) ask(k);
  for (let a = from, n = 1; a <= to; a += WINDOW, n++) {
    const b = Math.min(to, a + WINDOW - 1);
    const logs = await ahead.shift()!;
    ask(n - 1 + PREFETCH);
    // Markets first, then trades: a market's first trade may be logged before its MarketCreated in the same tx.
    for (const log of logs) {
      if (log.address.toLowerCase() !== factory || log.topics[0] !== MARKET_CREATED) continue;
      const c = decodeMarketCreated(log);
      const key = c.market.toLowerCase();
      if (!reg.markets[key]) {
        const t = await chain.token(c.pToken);
        reg.markets[key] = { market: key, pToken: c.pToken, symbol: t.symbol, decimals: t.decimals, createdBlock: Number(BigInt(log.blockNumber)) };
      }
      created.push(reg.markets[key]);
    }
    for (const log of logs) {
      const address = log.address.toLowerCase();
      if ((log.topics[0] === BOUGHT || log.topics[0] === SOLD) && reg.markets[address]) {
        const t = decodeTrade(log, reg.markets[address]);
        const who = t.trader.toLowerCase();
        if (reg.traders[who] === undefined || t.block < reg.traders[who]) reg.traders[who] = t.block;
        trades.push(t);
      }
    }
    if (b > reg.scannedTo && a <= reg.scannedTo + 1) reg.scannedTo = b;
    await onWindow?.(n, total);
  }
  return { trades, created };
}

/** Brings markets.json / traders.json up to `toBlock`, saving every 50 windows so a stopped scan resumes. */
export async function extendRegistry(
  chain: Chain,
  home: string,
  toBlock: number,
  start = SCAN_START,
  onProgress?: (scannedTo: number, toBlock: number) => void,
): Promise<Registry> {
  const reg = loadRegistry(home, start);
  if (reg.scannedTo >= toBlock) return reg;
  await readRange(chain, reg, reg.scannedTo + 1, toBlock, (n, total) => {
    if (n % 50 === 0 || n === total) {
      saveRegistry(home, reg);
      onProgress?.(reg.scannedTo, toBlock);
    }
  });
  saveRegistry(home, reg);
  return reg;
}
