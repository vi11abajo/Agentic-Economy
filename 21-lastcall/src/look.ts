// One full look at a wallet: find its loans in every venue, then for each loan work out the level, how far the
// price can fall, how many days the carry leaves, what to do about it, and rehearse that on the real contracts.
import type { Hex } from "viem";
import { readAave, type AaveWiring } from "./aave.js";
import type { Chain } from "./chain.js";
import { sampleBlocks, type Sample } from "./clock.js";
import { carryClock, dropToLiquidation, levelOf, movesToTarget, type Clock, type Level, type Move, type Snapshot, type Thresholds } from "./health.js";
import { readMorpho, type MarketParams } from "./morpho.js";
import { rehearseAave, rehearseMorpho, type Rehearsal } from "./simulate.js";
import { describeKeys } from "./tripwire.js";
import { AAVE_POOLS, MORPHO_MARKETS } from "./venues.js";

export interface Loan {
  snap: Snapshot;
  /** What the rules depend on. */
  aave?: { wiring: AaveWiring; poolKey: string };
  morpho?: { params: MarketParams; fixedTerms: boolean; debtRaw: bigint };
}

export interface Advice {
  move: Move;
  rehearsal: Rehearsal;
}

export interface Assessment {
  key: string;
  loan: Loan;
  level: Level;
  drop: number | null;
  clockNow: Clock;
  clockStress: Clock;
  /** Health we aimed the advice at (target, or higher when the clock is short). */
  aim: number;
  advice: Advice[];
  keys: string;
}

export const loanKey = (s: Snapshot) => `${s.kind}:${s.where.toLowerCase()}:${s.wallet.toLowerCase()}`;

export async function findLoans(chain: Chain, wallet: Hex, at: number, samples: Sample[], extraMarkets: Hex[] = []): Promise<Loan[]> {
  // All venues at once; chain.ts keeps at most a few requests in flight so the public node stays friendly.
  const markets = [...new Set([...MORPHO_MARKETS, ...extraMarkets].map((m) => m.toLowerCase() as Hex))];
  const [aave, morpho] = await Promise.all([
    Promise.all(AAVE_POOLS.map(async (p) => {
      const r = await readAave(chain, p, wallet, at, samples);
      return r ? ({ snap: r.snap, aave: { wiring: r.wiring, poolKey: p.key } } as Loan) : null;
    })),
    Promise.all(markets.map(async (id) => {
      const r = await readMorpho(chain, id, wallet, at, samples);
      return r ? ({ snap: r.snap, morpho: { params: r.params, fixedTerms: r.fixedTerms, debtRaw: r.debtRaw } } as Loan) : null;
    })),
  ]);
  return [...aave, ...morpho].filter((x): x is Loan => x !== null);
}

/**
 * Health we should aim the advice at. Normally the target. But if, at today's rates, the carry would eat the
 * headroom in under `daysWarn`, aim high enough to buy twice that: health h lasts ln(h)/|net| years.
 */
export function aimFor(clock: Clock, target: number, daysWarn: number): number {
  if (clock.net >= 0) return target;
  return Math.max(target, Math.exp((-clock.net * 2 * daysWarn) / 365));
}

export async function assess(chain: Chain, loan: Loan, t: Thresholds, daysWarn: number): Promise<Assessment> {
  const s = loan.snap;
  const clockNow = carryClock(s);
  const clockStress = carryClock(s, true);
  const aim = aimFor(clockNow, t.target, daysWarn);
  const moves = movesToTarget(s, aim);
  const advice: Advice[] = await Promise.all(moves.map(async (move) => ({
    move,
    rehearsal: loan.aave
      ? await rehearseAave(chain, s.where, s.wallet, move, s.block)
      : await rehearseMorpho(chain, s.where, loan.morpho!.params, s.wallet, move, loan.morpho!.debtRaw, s.block),
  })));
  const keys = loan.aave
    ? await describeKeys(chain, loan.aave.wiring.owner)
    : loan.morpho!.fixedTerms
      ? "fixed: the market id is the hash of its oracle, LLTV and rate model (checked), nobody can change them"
      : "market id does NOT match its params hash (unexpected)";
  return { key: loanKey(s), loan, level: levelOf(s.hf, t), drop: dropToLiquidation(s), clockNow, clockStress, aim, advice, keys };
}

export async function lookAt(chain: Chain, wallets: Hex[], t: Thresholds, daysWarn: number, at?: number, extraMarkets: Hex[] = []): Promise<{ block: number; time: number; out: Assessment[] }> {
  const block = at ?? (await chain.head());
  const samples = await sampleBlocks(chain, block);
  const loans = (await Promise.all(wallets.map((w) => findLoans(chain, w, block, samples, extraMarkets)))).flat();
  const out = await Promise.all(loans.map((loan) => assess(chain, loan, t, daysWarn)));
  return { block, time: await chain.timestamp(block), out };
}
