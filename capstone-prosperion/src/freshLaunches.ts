// The Launches list, kept honest. The watcher checks a market once, the moment it is created; a minute later
// someone may have bought in, and "nobody in yet" would be a lie. So every read re-checks the markets that were
// still on the curve last time we looked, at most once per fifteen seconds per market, and writes the result back
// (the agent's recent_launches reads the same rows). A market that graduated or failed cannot come back, so it is
// left alone. If the chain does not answer, the last check stays, with its block, and the page says which block.
import type { Address } from "viem";
import type { MarketCheck } from "./market.js";
import type { Launch, Store } from "./store.js";

const FRESH_FOR_S = 15;

export function launchRefresher(
  store: Store,
  check: (market: Address, amountIn: bigint) => Promise<MarketCheck>,
  nowS: () => number,
) {
  const checkedAt = new Map<string, number>();
  const running = new Map<string, Promise<void>>();

  const refresh = (l: Launch) => {
    const key = l.market.toLowerCase();
    const inFlight = running.get(key);
    if (inFlight) return inFlight;
    if (nowS() - (checkedAt.get(key) ?? -Infinity) < FRESH_FOR_S) return Promise.resolve();
    const p = check(l.market, BigInt(l.checks?.amountIn ?? 10n ** 18n))
      .then((c) => { store.saveLaunch({ ...l, checks: c }); checkedAt.set(key, nowS()); })
      .catch((e) => console.error(`[launches] re-check of ${l.market} failed: ${(e as Error).message}`))
      .finally(() => running.delete(key));
    running.set(key, p);
    return p;
  };

  return async (limit: number): Promise<Launch[]> => {
    const open = store.listLaunches(limit).filter((l) => l.checks?.genuine && l.checks.phase === 0);
    await Promise.all(open.map(refresh));
    return store.listLaunches(limit);
  };
}
