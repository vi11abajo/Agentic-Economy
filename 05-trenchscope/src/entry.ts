// What you paid for a bag you bought by hand: your Prosper buys and sells of this token, read from the
// Bought/Sold events in your transactions (the explorer only tells us which transactions to look at).
import { decodeEventLog, formatEther, getAddress, type Address, type Hex, type PublicClient } from "viem";
import { retry } from "./chain.js";
import { transfers } from "./explorer.js";
import { curveEvents } from "./prosper.js";

export interface Fill {
  side: "buy" | "sell";
  block: number;
  logIndex: number;
  pros: number; // paid in (buy, before fee) or received (sell, after fee)
  tokens: number;
}

/** Average cost of what's still held: a sell takes its share of the cost out with it. */
export function costBasis(fills: Fill[]): { cost: number; tokens: number } {
  let cost = 0;
  let tokens = 0;
  for (const f of [...fills].sort((a, b) => a.block - b.block || a.logIndex - b.logIndex)) {
    if (f.side === "buy") {
      cost += f.pros;
      tokens += f.tokens;
    } else if (tokens > 0) {
      const part = Math.min(1, f.tokens / tokens);
      cost -= cost * part;
      tokens -= Math.min(tokens, f.tokens);
    }
  }
  return { cost, tokens };
}

export async function findFills(client: PublicClient, market: Address, token: Address, wallet: Address): Promise<Fill[]> {
  const me = wallet.toLowerCase();
  const txs = new Set((await transfers(token)).filter((t) => t.to === me || t.from === me).map((t) => t.tx));
  const fills: Fill[] = [];
  for (const hash of txs) {
    const receipt = await retry(() => client.getTransactionReceipt({ hash: hash as Hex }));
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== market) continue;
      try {
        const ev = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
        const a = ev.args as unknown as Record<string, bigint | string>;
        if ((a.trader as string).toLowerCase() !== me) continue;
        const buy = ev.eventName === "Bought";
        fills.push({
          side: buy ? "buy" : "sell",
          block: Number(log.blockNumber),
          logIndex: Number(log.logIndex),
          pros: Number(formatEther((buy ? a.grossIn : a.netOut) as bigint)),
          tokens: Number(formatEther((buy ? a.pTokenOut : a.pTokenIn) as bigint)),
        });
      } catch {
        // not a trade event (e.g. an approval or transfer in the same tx)
      }
    }
  }
  return fills;
}
