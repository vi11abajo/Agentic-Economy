// One indexer for every Prosper curve: scans blocks in order through Pharos Chain MCP with a single get_logs
// per window (ProsperFactory + all known markets, topics MarketCreated | Bought | Sold), stores everything in
// SQLite and emits new trades. Load on Pharos MCP does not depend on how many people use our server.
import { EventEmitter } from "node:events";
import type { Address, Hex } from "viem";
import { PharosMcp } from "@agentic-economy/pharos-mcp";
import { config } from "./config.js";
import type { Db } from "./db.js";
import {
  BOUGHT, MARKET_CREATED, ON_CURVE, PHASE_LABEL, PROSPER_FACTORY, SOLD, decodeMarketCreated, decodeTrade, readPhase, readToken,
  type MarketRow, type RpcLog, type TradeRow,
} from "./prosper.js";

const PHASE_REFRESH_MS = 5 * 60_000;

const WINDOW = 1000n; // Pharos MCP get_logs limit (inclusive)

export interface IndexerStatus {
  head: number;
  indexedTo: number;
  live: boolean;
  markets: number;
  mcpCalls: number;
  startedAt: string;
}

export class Indexer extends EventEmitter {
  private readonly mcp = new PharosMcp("prosper-monitor-indexer");
  private readonly markets = new Map<string, MarketRow>();
  readonly status: IndexerStatus = { head: 0, indexedTo: 0, live: false, markets: 0, mcpCalls: 0, startedAt: new Date().toISOString() };

  constructor(private readonly db: Db) {
    super();
    for (const m of db.markets()) this.markets.set(m.market, m);
    this.status.markets = this.onCurve().length;
  }

  /** On-curve market by id (graduated / curve-only markets are not part of the monitor). */
  market(id: string): MarketRow | undefined {
    const m = this.markets.get(id.toLowerCase());
    return m && m.phase === ON_CURVE ? m : undefined;
  }

  /** Markets currently on the bonding curve (phase 0). These are the only ones the monitor follows. */
  allMarkets(): MarketRow[] {
    return this.onCurve();
  }

  onCurveIds(): string[] {
    return this.onCurve().map((m) => m.market);
  }

  private onCurve(): MarketRow[] {
    return [...this.markets.values()].filter((m) => m.phase === ON_CURVE);
  }

  /** Re-reads phase() of every market that is (or may still be) on the curve; drops the ones that left it. */
  private async refreshPhases(): Promise<void> {
    for (const m of this.markets.values()) {
      if (m.phase !== undefined && m.phase !== null && m.phase !== ON_CURVE) continue;
      const phase = await readPhase(this.mcp, m.market);
      if (phase === m.phase) continue;
      const was = m.phase;
      m.phase = phase;
      this.db.setPhase(m.market, phase);
      if (was === ON_CURVE) {
        console.log(`[indexer] ${m.symbol} left the curve: ${PHASE_LABEL[phase] ?? phase}`);
        this.emit("phase", { ...m, label: PHASE_LABEL[phase] ?? String(phase) });
      }
    }
    this.status.markets = this.onCurve().length;
  }

  async run(): Promise<never> {
    await this.mcp.connect();
    let next = BigInt(this.db.meta("nextBlock") ?? config.startBlock.toString());
    let phasesAt = 0;
    for (;;) {
      try {
        if (Date.now() - phasesAt > PHASE_REFRESH_MS) {
          await this.refreshPhases();
          phasesAt = Date.now();
        }
        const head = BigInt((await this.mcp.call<{ blockNumber: string }>("get_block_number")).blockNumber);
        const safe = head - config.confirmations;
        this.status.head = Number(head);
        while (next <= safe) {
          const to = next + WINDOW - 1n < safe ? next + WINDOW - 1n : safe;
          const live = safe - to < 30n;
          await this.scan(next, to, live);
          next = to + 1n;
          this.db.setMeta("nextBlock", next.toString());
          this.status.indexedTo = Number(to);
          this.status.live = live;
          this.status.mcpCalls = this.mcp.calls;
        }
        this.emit("status", this.status);
      } catch (err) {
        console.error(`[indexer] ${err instanceof Error ? err.message : err}`);
      }
      await new Promise((r) => setTimeout(r, config.pollMs));
    }
  }

  private async scan(from: bigint, to: bigint, live: boolean): Promise<void> {
    const logs = await this.getLogs([PROSPER_FACTORY, ...this.onCurveIds()], [MARKET_CREATED, BOUGHT, SOLD], from, to);
    const created: MarketRow[] = [];
    for (const log of logs) {
      if (log.removed) continue;
      if (log.address.toLowerCase() === PROSPER_FACTORY.toLowerCase() && log.topics[0] === MARKET_CREATED) {
        created.push(await this.addMarket(log));
      } else {
        this.addTrade(log, live);
      }
    }
    // Trades of a market created inside this window were not in the query above: fetch them now.
    const fresh = created.filter((m) => m.phase === ON_CURVE);
    if (fresh.length) {
      const extra = await this.getLogs(fresh.map((m) => m.market), [BOUGHT, SOLD], BigInt(Math.min(...fresh.map((m) => m.createdBlock))), to);
      for (const log of extra) if (!log.removed) this.addTrade(log, live);
    }
  }

  private async getLogs(address: string[], topic0: string[], from: bigint, to: bigint): Promise<RpcLog[]> {
    const logs = await this.mcp.call<RpcLog[]>("get_logs", {
      address,
      topics: [topic0],
      fromBlock: `0x${from.toString(16)}`,
      toBlock: `0x${to.toString(16)}`,
    });
    return logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
  }

  private async addMarket(log: RpcLog): Promise<MarketRow> {
    const c = decodeMarketCreated(log);
    const token = await readToken(this.mcp, c.pToken as Address);
    const row: MarketRow = {
      market: c.market.toLowerCase(),
      pToken: c.pToken,
      vault: c.vault,
      creator: c.creator,
      symbol: token.symbol,
      name: token.name,
      decimals: token.decimals,
      createdBlock: Number(BigInt(log.blockNumber)),
      createdTime: log.blockTimestamp ? Number(BigInt(log.blockTimestamp as Hex)) : 0,
      phase: await readPhase(this.mcp, c.market),
    };
    this.db.upsertMarket(row);
    this.markets.set(row.market, row);
    this.status.markets = this.onCurve().length;
    console.log(`[indexer] market ${row.symbol} ${row.market} (block ${row.createdBlock}, ${PHASE_LABEL[row.phase!] ?? row.phase})`);
    if (row.phase === ON_CURVE) this.emit("market", row);
    return row;
  }

  private addTrade(log: RpcLog, live: boolean): void {
    const m = this.markets.get(log.address.toLowerCase());
    if (!m || m.phase !== ON_CURVE) return;
    const trade: TradeRow = decodeTrade(log, m);
    if (this.db.insertTrade(trade) && live) this.emit("trade", trade);
  }
}
