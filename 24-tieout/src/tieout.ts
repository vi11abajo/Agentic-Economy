// The part an accountant actually trusts: for every asset, opening balance + money in - money out - gas has to land
// exactly on the closing balance. Both balances are read from the chain at the period's edge blocks, the flows come
// from the receipts, so if the explorer skipped a transaction (or a token moves without Transfer events, like an
// interest-bearing token) the books stop tying and the report says by how much instead of hiding it.
import type { Chain } from "./chain.js";
import type { Hex } from "./explorer.js";
import { NATIVE, type Entry } from "./ledger.js";

export interface AssetLine {
  asset: string;
  opening: bigint;
  in: bigint;
  out: bigint;
  fees: bigint;
  expected: bigint;
  closing: bigint;
  /** closing - expected: zero when the books tie. null when the chain wouldn't give a balance. */
  gap: bigint | null;
}

export async function tieOut(chain: Chain, wallet: Hex, entries: Entry[], assets: string[], openBlock: bigint, closeBlock: bigint): Promise<AssetLine[]> {
  const balance = (asset: string, block: bigint) =>
    asset === NATIVE ? chain.nativeBalance(wallet, block) : chain.tokenBalance(asset as Hex, wallet, block);

  const lines = await Promise.all(
    assets.map(async (asset): Promise<AssetLine> => {
      let inSum = 0n;
      let outSum = 0n;
      for (const e of entries)
        for (const f of e.flows) {
          if (f.asset !== asset) continue;
          if (f.dir === "in") inSum += f.amount;
          else outSum += f.amount;
        }
      const fees = asset === NATIVE ? entries.reduce((s, e) => s + e.fee, 0n) : 0n;
      const [open, close] = await Promise.all([balance(asset, openBlock), balance(asset, closeBlock)]);
      // a token that didn't exist yet at the opening block simply had nothing in it
      const opening = open ?? 0n;
      const expected = opening + inSum - outSum - fees;
      return {
        asset,
        opening,
        in: inSum,
        out: outSum,
        fees,
        expected,
        closing: close ?? 0n,
        gap: close === null ? null : close - expected,
      };
    }),
  );
  return lines;
}

export const ties = (l: AssetLine) => l.gap === 0n;
