// The watch list. It's a plain JSON file you can edit; `sonar discover` writes one from the explorer's list of the
// biggest PROS holders, keeping only wallets (not contracts) that moved recently.
import { getAddress, isAddress } from "viem";
import type { Whale } from "./explain.js";
import { fmt } from "./explain.js";
import type { Get } from "./pharos.js";

export interface WatchList {
  minUsd: number;
  whales: Whale[];
}

export class ListError extends Error {}

export function parseList(text: string): WatchList {
  let j: { minUsd?: unknown; whales?: unknown };
  try {
    j = JSON.parse(text);
  } catch (e) {
    throw new ListError(`the watch list isn't valid JSON: ${(e as Error).message}`);
  }
  if (!Array.isArray(j.whales) || j.whales.length === 0) throw new ListError(`the watch list needs a non-empty "whales" list`);
  const minUsd = j.minUsd === undefined ? 1000 : Number(j.minUsd);
  if (!Number.isFinite(minUsd) || minUsd < 0) throw new ListError(`"minUsd" must be a number >= 0`);
  const seen = new Set<string>();
  const whales = (j.whales as Array<Record<string, unknown>>).map((w, i) => {
    const a = String(w.address ?? "");
    if (!isAddress(a, { strict: false })) throw new ListError(`whale ${i + 1}: ${JSON.stringify(w.address)} is not an address`);
    const address = getAddress(a.toLowerCase()).toLowerCase();
    if (seen.has(address)) throw new ListError(`${address} is in the list twice`);
    seen.add(address);
    const own = w.minUsd === undefined ? undefined : Number(w.minUsd);
    if (own !== undefined && (!Number.isFinite(own) || own < 0)) throw new ListError(`whale ${address}: "minUsd" must be a number >= 0`);
    return { address, label: typeof w.label === "string" && w.label.trim() ? w.label.trim() : address, minUsd: own };
  });
  return { minUsd, whales };
}

interface TopRow {
  rank: number;
  address: string;
  balance: string;
  block_timestamp: string;
  addr?: { is_contract?: boolean };
}

/** The biggest PROS holders that are wallets and whose row on that list was updated in the last `activeHours`. */
export async function discover(get: Get, count: number, activeHours: number, now = new Date()): Promise<WatchList & { note: string }> {
  const since = new Date(now.getTime() - activeHours * 3_600_000).toISOString();
  const picked: Array<Whale & { note: string }> = [];
  let looked = 0;
  for (let page = 1; page <= 5 && picked.length < count; page++) {
    const rows = ((await get(`top-accounts?page=${page}&size=100`)) as { data?: TopRow[] }).data ?? [];
    looked += rows.length;
    for (const r of rows) {
      if (r.addr?.is_contract || r.block_timestamp < since) continue;
      picked.push({ address: r.address.toLowerCase(), label: `#${r.rank} PROS holder`, note: `${fmt(Number(r.balance))} PROS on ${now.toISOString().slice(0, 10)}, from the pharosscan top accounts list` });
      if (picked.length === count) break;
    }
    if (rows.length < 100) break;
  }
  return { minUsd: 1000, whales: picked, note: `looked at the top ${looked} PROS holders, kept wallets active since ${since}` };
}
