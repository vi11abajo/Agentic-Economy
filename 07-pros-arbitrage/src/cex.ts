// PROS/USDT spot order books from the exchanges' public APIs (no keys), and filling an order against them.
export type Exchange = "okx" | "bitget" | "mexc";
export const EXCHANGES: Exchange[] = ["okx", "bitget", "mexc"];

export interface Book {
  exchange: Exchange;
  bids: [number, number][]; // [price, size], best first
  asks: [number, number][];
  at: number; // exchange timestamp, ms
}

const URLS: Record<Exchange, string> = {
  okx: "https://www.okx.com/api/v5/market/books?instId=PROS-USDT&sz=400",
  bitget: "https://api.bitget.com/api/v2/spot/market/orderbook?symbol=PROSUSDT&type=step0&limit=150",
  mexc: "https://api.mexc.com/api/v3/depth?symbol=PROSUSDT&limit=500",
};

const levels = (rows: unknown[]): [number, number][] => rows.map((r) => [Number((r as string[])[0]), Number((r as string[])[1])]);

export function parseBook(exchange: Exchange, json: unknown): Book {
  const j = json as Record<string, any>;
  if (exchange === "okx") {
    const d = j.data?.[0];
    if (j.code !== "0" || !d) throw new Error(`okx: ${j.msg || "no book"}`);
    return { exchange, bids: levels(d.bids), asks: levels(d.asks), at: Number(d.ts) };
  }
  if (exchange === "bitget") {
    const d = j.data;
    if (j.code !== "00000" || !d) throw new Error(`bitget: ${j.msg || "no book"}`);
    return { exchange, bids: levels(d.bids), asks: levels(d.asks), at: Number(d.ts) };
  }
  if (!Array.isArray(j.bids)) throw new Error(`mexc: ${j.msg || "no book"}`);
  return { exchange, bids: levels(j.bids), asks: levels(j.asks), at: Date.now() };
}

export async function fetchBook(exchange: Exchange): Promise<Book> {
  const res = await fetch(URLS[exchange], { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "prosArbitrage/1.0" } });
  if (!res.ok) throw new Error(`${exchange}: HTTP ${res.status}`);
  return parseBook(exchange, await res.json());
}

export interface Fill {
  base: number; // PROS
  quote: number; // USDT
  avg: number;
  worst: number; // the deepest level touched: the limit price an order would need
  complete: boolean; // false when the book isn't deep enough
}

/** Market buy: spend `quote` USDT walking up the asks. Fees not included. */
export function buyWithQuote(book: Book, quote: number): Fill {
  let left = quote;
  let base = 0;
  let worst = book.asks[0]?.[0] ?? 0;
  for (const [p, q] of book.asks) {
    if (left <= 1e-12) break;
    const take = Math.min(q, left / p);
    base += take;
    left -= take * p;
    worst = p;
  }
  const spent = quote - left;
  return { base, quote: spent, avg: base > 0 ? spent / base : 0, worst, complete: left <= 1e-9 };
}

/** Market sell: sell `base` PROS walking down the bids. Fees not included. */
export function sellBase(book: Book, base: number): Fill {
  let left = base;
  let quote = 0;
  let worst = book.bids[0]?.[0] ?? 0;
  for (const [p, q] of book.bids) {
    if (left <= 1e-12) break;
    const take = Math.min(q, left);
    quote += take * p;
    left -= take;
    worst = p;
  }
  const sold = base - left;
  return { base: sold, quote, avg: sold > 0 ? quote / sold : 0, worst, complete: left <= 1e-9 };
}
