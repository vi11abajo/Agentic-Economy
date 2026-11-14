// Who bought and sold on Prosper's curves, from the markets' own events. Each market logs a buy as
// (caller, recipient, PROS paid, PROS that reached the curve, tokens out, fee) and a sell as
// (caller, recipient, tokens in, PROS before fee, PROS paid out, fee); the layout was read off real receipts
// (pFROG 0xd73c66a5…, 0x65a1e01b…) and the numbers add up to the last wei, but the market's source is not
// verified, so the event names are ours.
// One eth_getLogs per 1000 blocks covers every market at once (the RPC refuses wider windows). The indexer walks
// from the first launch to the head and then follows the head, so a question about buyers is a SQLite read.
import { getAddress, type Address, type Hex } from "viem";
import type { DatabaseSync } from "node:sqlite";

export const BUY_TOPIC = "0x2683a506cc521e11c368ce9c068585a91786a3cb7ab4089b602eb2835acb1639" as Hex;
export const SELL_TOPIC = "0x666da611e344dba8722aebfe320a3fa6119e933328fee40aa617bebd04b8efaf" as Hex;
const WINDOW = 1000n;

export interface RawTradeLog {
  address: string;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  transactionHash: Hex;
  logIndex: string;
}
export interface Trade {
  market: Address;
  block: bigint;
  tx: Hex;
  logIndex: number;
  kind: "buy" | "sell";
  /** buy: who got the tokens; sell: who got the PROS */
  trader: Address;
  /** the contract that called the market: Prosper's router, our gate, or the trader */
  caller: Address;
  /** buy: PROS paid; sell: PROS before the fee */
  prosGross: bigint;
  /** buy: PROS that reached the curve; sell: PROS paid out */
  prosNet: bigint;
  tokens: bigint;
  fee: bigint;
}

const word = (data: Hex, i: number) => BigInt(`0x${data.slice(2 + i * 64, 2 + (i + 1) * 64)}`);
const topicAddress = (t: Hex) => getAddress(`0x${t.slice(26)}`);

export function decodeTrade(l: RawTradeLog): Trade | null {
  const kind = l.topics[0] === BUY_TOPIC ? "buy" : l.topics[0] === SELL_TOPIC ? "sell" : null;
  if (!kind || l.topics.length < 3 || l.data.length < 2 + 4 * 64) return null;
  const w = [0, 1, 2, 3].map((i) => word(l.data, i));
  const base = {
    market: getAddress(l.address), block: BigInt(l.blockNumber), tx: l.transactionHash, logIndex: Number(l.logIndex), kind,
    caller: topicAddress(l.topics[1]), trader: topicAddress(l.topics[2]), fee: w[3],
  } as const;
  return kind === "buy"
    ? { ...base, prosGross: w[0], prosNet: w[1], tokens: w[2] }
    : { ...base, tokens: w[0], prosGross: w[1], prosNet: w[2] };
}

export interface MarketSummary {
  market: Address;
  buys: number;
  sells: number;
  buyers: number;
  sellers: number;
  prosInGross: bigint;
  prosOutNet: bigint;
  feesPaid: bigint;
  firstTrade: bigint | null;
  lastTrade: bigint | null;
  /** tokens bought minus tokens sold per wallet, from curve trades only (wallet-to-wallet transfers are not seen) */
  holdersFromCurve: { wallet: Address; tokens: bigint; prosPaid: bigint }[];
  /** wallets that bought and then sold everything back on the curve */
  roundTrips: Address[];
}

export function openTradeBook(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS trades (tx TEXT, log_index INTEGER, market TEXT, block INTEGER, kind TEXT, trader TEXT,
      caller TEXT, pros_gross TEXT, pros_net TEXT, tokens TEXT, fee TEXT, PRIMARY KEY (tx, log_index));
    CREATE INDEX IF NOT EXISTS trades_market ON trades (market, block);
    CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
  `);
  const getKv = (k: string) => (db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined)?.v;
  const setKv = (k: string, v: string) => db.prepare("INSERT OR REPLACE INTO kv VALUES (?, ?)").run(k, v);
  const row = (r: Record<string, unknown>): Trade => ({
    tx: r.tx as Hex, logIndex: r.log_index as number, market: r.market as Address, block: BigInt(r.block as number),
    kind: r.kind as "buy" | "sell", trader: r.trader as Address, caller: r.caller as Address,
    prosGross: BigInt(r.pros_gross as string), prosNet: BigInt(r.pros_net as string), tokens: BigInt(r.tokens as string), fee: BigInt(r.fee as string),
  });

  return {
    save(ts: Trade[]) {
      const ins = db.prepare("INSERT OR IGNORE INTO trades VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
      for (const t of ts) {
        ins.run(t.tx, t.logIndex, t.market, Number(t.block), t.kind, t.trader, t.caller, t.prosGross.toString(), t.prosNet.toString(), t.tokens.toString(), t.fee.toString());
      }
    },
    coverage(): { from: bigint; to: bigint } | null {
      const f = getKv("trades.from"), t = getKv("trades.to");
      return f && t ? { from: BigInt(f), to: BigInt(t) } : null;
    },
    setCoverage(from: bigint, to: bigint) { setKv("trades.from", from.toString()); setKv("trades.to", to.toString()); },
    trades(market: Address, limit: number): Trade[] {
      return (db.prepare("SELECT * FROM trades WHERE market = ? ORDER BY block DESC, log_index DESC LIMIT ?")
        .all(getAddress(market), limit) as Record<string, unknown>[]).map(row);
    },
    summary(market: Address): MarketSummary {
      const all = (db.prepare("SELECT * FROM trades WHERE market = ? ORDER BY block, log_index").all(getAddress(market)) as Record<string, unknown>[]).map(row);
      const pos = new Map<Address, { tokens: bigint; prosPaid: bigint; sold: boolean }>();
      const s: MarketSummary = {
        market: getAddress(market), buys: 0, sells: 0, buyers: 0, sellers: 0, prosInGross: 0n, prosOutNet: 0n, feesPaid: 0n,
        firstTrade: all[0]?.block ?? null, lastTrade: all.at(-1)?.block ?? null, holdersFromCurve: [], roundTrips: [],
      };
      const buyers = new Set<Address>(), sellers = new Set<Address>();
      for (const t of all) {
        const p = pos.get(t.trader) ?? { tokens: 0n, prosPaid: 0n, sold: false };
        s.feesPaid += t.fee;
        if (t.kind === "buy") { s.buys++; buyers.add(t.trader); s.prosInGross += t.prosGross; p.tokens += t.tokens; p.prosPaid += t.prosGross; }
        else { s.sells++; sellers.add(t.trader); s.prosOutNet += t.prosNet; p.tokens -= t.tokens; p.sold = true; }
        pos.set(t.trader, p);
      }
      s.buyers = buyers.size;
      s.sellers = sellers.size;
      for (const [wallet, p] of pos) {
        if (p.tokens > 0n) s.holdersFromCurve.push({ wallet, tokens: p.tokens, prosPaid: p.prosPaid });
        else if (p.sold && buyers.has(wallet)) s.roundTrips.push(wallet);
      }
      s.holdersFromCurve.sort((a, b) => (b.tokens > a.tokens ? 1 : b.tokens < a.tokens ? -1 : 0));
      return s;
    },
  };
}
export type TradeBook = ReturnType<typeof openTradeBook>;

export interface IndexerDeps {
  head: () => Promise<bigint>;
  markets: () => Promise<Address[]>;
  getLogs: (markets: Address[], from: bigint, to: bigint) => Promise<RawTradeLog[]>;
  /** where to start on a fresh database: the block of Prosper's first launch */
  startBlock: () => Promise<bigint>;
  /** new trades from a window near the head, for the bot */
  onTrades?: (trades: Trade[]) => Promise<void>;
}

/** How close to the head a window must be for its trades to count as news (about five minutes of blocks). */
export const LIVE_BLOCKS = 600n;

export class TradeIndexer {
  constructor(private book: TradeBook, private deps: IndexerDeps) {}

  /** Indexes one window. Returns false when there was nothing new to read. */
  async step(): Promise<boolean> {
    const cov = this.book.coverage();
    const from = cov ? cov.to + 1n : await this.deps.startBlock();
    const head = await this.deps.head();
    if (from > head) return false;
    const to = from + WINDOW - 1n < head ? from + WINDOW - 1n : head;
    const markets = await this.deps.markets();
    const logs = markets.length ? await this.deps.getLogs(markets, from, to) : [];
    const trades = logs.map(decodeTrade).filter((t): t is Trade => t !== null);
    this.book.save(trades);
    this.book.setCoverage(cov?.from ?? from, to);
    // live trades only: a backfill of last week is history, not news
    if (this.deps.onTrades && trades.length && head - to <= LIVE_BLOCKS) await this.deps.onTrades(trades);
    return true;
  }

  /** Runs forever: fast while behind, a gentle poll once at the head. Errors wait and retry. */
  async run(onError: (e: Error) => void, behindPauseMs = 250, idleMs = 3000) {
    for (;;) {
      let more = false;
      try { more = await this.step(); } catch (e) { onError(e as Error); await sleep(5000); continue; }
      await sleep(more ? behindPauseMs : idleMs);
    }
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
