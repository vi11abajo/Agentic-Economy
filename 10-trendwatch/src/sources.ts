// Where observations come from. A source turns "what happened since the last one I stored" into closed,
// ordered observations, so a run after any downtime picks up exactly where the last one stopped.
//   okx:<instId>             closed candles of any OKX instrument, public market API, no key
//   pharos-pool:<address>    the price in a Uniswap-V3-style pool on Pharos (slot0), sampled every N blocks,
//                            read at exact past blocks through the Pharos Chain MCP
import { PharosMcp } from "@agentic-economy/pharos-mcp";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";

export interface Observation {
  key: string; // unique and sortable: the candle's open time, or the block number, zero-padded
  t: number; // ms, when the observation closed
  close: number;
  high?: number;
  low?: number;
  block?: number;
}

export interface Candle {
  t: number; // open time, ms
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface Source {
  /** Closed observations after `afterKey` (all of them since `sinceMs` when nothing is stored yet), oldest first. */
  fetch(afterKey: string | undefined, sinceMs: number): Promise<Observation[]>;
  /** Closed candles of another timeframe, for the EMA filter; OKX only. */
  candles?(bar: string, sinceMs: number): Promise<Candle[]>;
  close?(): Promise<void>;
}

export const BAR_MS: Record<string, number> = {
  "1m": 60_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000, "1H": 3_600_000, "4H": 14_400_000, "1D": 86_400_000,
};

export const padKey = (n: number) => String(n).padStart(16, "0");

// ---------- OKX ----------

type Fetcher = (url: string) => Promise<unknown>;
const OKX = process.env.TRENDWATCH_OKX_URL || "https://www.okx.com";

async function httpJson(url: string): Promise<unknown> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) }).catch((e) => e as Error);
    if (!(res instanceof Error) && res.ok) return res.json();
    // OKX allows 20-40 requests per 2 s on these endpoints; back off on a limit or a dropped connection.
    if (i >= 4) throw new Error(`OKX ${url.split("?")[0]}: ${res instanceof Error ? res.message : `HTTP ${res.status}`}`);
    await new Promise((r) => setTimeout(r, 800 * (i + 1)));
  }
}

/** OKX candle rows: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]; newest first. confirm "1" = closed. */
function rows(json: unknown, what: string): string[][] {
  const j = json as { code?: string; msg?: string; data?: string[][] };
  if (j.code !== "0" || !Array.isArray(j.data)) throw new Error(`OKX ${what}: ${j.msg || `code ${j.code}`}`);
  return j.data;
}

export function okxSource(instId: string, bar: string, get: Fetcher = httpJson): Source {
  if (!BAR_MS[bar]) throw new Error(`unsupported bar ${bar}; use one of ${Object.keys(BAR_MS).join(", ")}`);
  const q = (path: string, b: string, extra = "") => `${OKX}/api/v5/market/${path}?instId=${encodeURIComponent(instId)}&bar=${b}${extra}`;

  /** Closed candles of `b` with open time > fromMs, oldest first: the recent endpoint, then pages of history. */
  async function closed(b: string, fromMs: number): Promise<Candle[]> {
    const seen = new Map<number, Candle>();
    const add = (r: string[]) => {
      if (r[8] !== "1") return; // the candle still forming
      const t = Number(r[0]);
      if (t > fromMs) seen.set(t, { t, open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) });
    };
    const recent = rows(await get(q("candles", b, "&limit=300")), `candles ${instId}`);
    if (!recent.length) throw new Error(`OKX has no candles for ${instId}`);
    recent.forEach(add);
    let oldest = Number(recent[recent.length - 1][0]);
    while (oldest > fromMs) {
      const page = rows(await get(q("history-candles", b, `&limit=100&after=${oldest}`)), `history ${instId}`);
      if (!page.length) break;
      page.forEach(add);
      const next = Number(page[page.length - 1][0]);
      if (next >= oldest) break;
      oldest = next;
    }
    return [...seen.values()].sort((x, y) => x.t - y.t);
  }

  return {
    async fetch(afterKey, sinceMs) {
      const from = afterKey ? Number(afterKey) : sinceMs - 1;
      return (await closed(bar, from)).map((c) => ({ key: padKey(c.t), t: c.t + BAR_MS[bar], close: c.close, high: c.high, low: c.low }));
    },
    candles: (b, sinceMs) => closed(b, sinceMs - 1),
  };
}

// ---------- a pool on Pharos ----------

const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function token1() view returns (address)",
]);
const erc20 = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

export interface ChainReader {
  call(to: Address, data: Hex, block?: number): Promise<Hex>;
  latest(): Promise<number>;
  timestamp(block: number): Promise<number>; // seconds
  close(): Promise<void>;
}

export async function mcpReader(): Promise<ChainReader> {
  const mcp = new PharosMcp("trendwatch");
  await mcp.connect();
  return {
    call: async (to, data, block) => (await mcp.call<{ result: Hex }>("eth_call", { transaction: { to, data }, ...(block === undefined ? {} : { block }) })).result,
    latest: async () => Number((await mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber),
    timestamp: async (block) => Number((await mcp.call<{ timestamp: string }>("get_block", { block })).timestamp),
    close: () => mcp.close(),
  };
}

/** Price of `base` in the other token of the pool, from slot0 at a block. */
export async function poolPrice(r: ChainReader, pool: Address, base: Address, block?: number): Promise<number> {
  const read = async <T>(to: Address, abi: typeof poolAbi | typeof erc20, fn: string): Promise<T> =>
    decodeFunctionResult({ abi, functionName: fn, data: await r.call(to, encodeFunctionData({ abi, functionName: fn } as never), block) } as never) as T;
  const [slot0, t0, t1] = await Promise.all([read<readonly bigint[]>(pool, poolAbi, "slot0"), read<Address>(pool, poolAbi, "token0"), read<Address>(pool, poolAbi, "token1")]);
  const [d0, d1] = await Promise.all([read<number>(t0, erc20, "decimals"), read<number>(t1, erc20, "decimals")]);
  const raw = (Number(slot0[0]) / 2 ** 96) ** 2; // token1 per token0, in base units
  const oneIn1 = raw * 10 ** (d0 - d1); // whole token1 per whole token0
  if (getAddress(base) === getAddress(t0)) return oneIn1;
  if (getAddress(base) === getAddress(t1)) return 1 / oneIn1;
  throw new Error(`${base} is neither token of pool ${pool}`);
}

export function poolSource(pool: string, base: string, everyBlocks: number, reader: () => Promise<ChainReader>): Source {
  if (!isAddress(pool, { strict: false }) || !isAddress(base, { strict: false })) throw new Error("pharos-pool needs the pool address and --base <token address>");
  let r: ChainReader | undefined;
  return {
    async fetch(afterKey, sinceMs) {
      r ??= await reader();
      const latest = (await r.latest()) - 1; // a step behind the head: the newest block may not be on every node yet
      let start: number;
      if (afterKey) start = Number(afterKey) + everyBlocks;
      else {
        // About one block a second on Pharos: go back from the latest block by the time since sinceMs, then up
        // to the next multiple of everyBlocks, so samples sit on a fixed grid and a restart lands on the same blocks.
        const tLatest = (await r.timestamp(latest)) * 1000;
        const approx = Math.max(1, latest - Math.ceil((tLatest - sinceMs) / 1000));
        start = Math.ceil(approx / everyBlocks) * everyBlocks;
      }
      const out: Observation[] = [];
      for (let b = start; b <= latest; b += everyBlocks) {
        const [close, ts] = [await poolPrice(r, getAddress(pool), getAddress(base), b), await r.timestamp(b)];
        out.push({ key: padKey(b), t: ts * 1000, close, block: b });
      }
      return out;
    },
    async close() {
      await r?.close();
    },
  };
}
