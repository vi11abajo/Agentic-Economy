// Shapes shared by the digest modules and stored in history.jsonl.

/** Key numbers of one period. PROS amounts are floats, like prosper-monitor's. */
export interface Metrics {
  volume: number; // buys (gross in) + sells (net out)
  buys: number;
  sells: number;
  netFlow: number; // buys - sells
  trades: number;
  traders: number;
  newTraders: number; // first Prosper trade ever falls in the period
  fees: number;
  newMarkets: number;
  graduated: number;
  onCurve: number; // markets on curve at the period's last block
}

export interface TokenStat {
  market: string;
  symbol: string;
  volume: number;
  trades: number;
  firstPrice: number;
  lastPrice: number;
  changePct: number | null; // first to last trade price in the period; null below 2 trades
  phaseEnd: number | null;
}

export interface DigestEvent {
  kind: "graduation" | "big_trade" | "mover" | "new_market" | "net_buyer";
  score: number;
  title: string;
  tx?: string;
  market?: string;
}

export interface TopTrade {
  symbol: string;
  side: "BUY" | "SELL";
  pros: number;
  trader: string;
  tx: string;
}

export interface Digest {
  key: string;
  label: string;
  days: number;
  start: number; // unix seconds, inclusive
  end: number; // unix seconds, exclusive
  startBlock: number;
  endBlock: number;
  readAt: number; // unix seconds
  metrics: Metrics;
  prev?: Metrics;
  tokens: TokenStat[];
  topTrades: TopTrade[];
  newMarkets: string[]; // symbols
  graduated: string[]; // symbols
  events: DigestEvent[];
  candidates: DigestEvent[];
  trends: string[];
  delivered: { telegram?: string; discord?: string };
  /** Last failed send per channel; a failed, undelivered digest is sent again by the next run. */
  failed?: { telegram?: string; discord?: string };
}
