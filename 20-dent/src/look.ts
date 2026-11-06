// One full look: read every place in the lane, work out what moving would cost for each, decide, and (when the
// answer is MOVE) lay out the transactions for the user's wallet.
import { formatUnits } from "viem";
import { feed } from "./abis.js";
import { blockSecondsAgo, type Chain } from "./chain.js";
import { decide, type Costs, type Decision, type Place } from "./decide.js";
import { buildSteps, estimateAll, type Plan, type Step } from "./plan.js";
import { Reader, type Evidence } from "./reads.js";
import { readSource, type Reading, type Windows } from "./sources.js";
import { LANE_DECIMALS, PROS_USD_FEED, SOURCES, type Lane } from "./venues.js";

export interface LookArgs {
  wallet: string;
  lane: Lane;
  /** Source id to move from; default: wherever the wallet holds the most in this lane. */
  from?: string;
  /** Amount in lane units (e.g. "250" USDC); default: everything held there. */
  amount?: string;
  holdDays: number;
  /** Smallest net gain worth signing for, in lane units. */
  minGain: number;
  /** PROS kept back for gas when moving PROS out of the wallet itself. */
  keepPros: number;
}

export interface Look {
  block: number;
  at: string;
  windows: Windows;
  lane: Lane;
  wallet: string;
  readings: Reading[];
  gasPriceWei: string;
  prosUsd?: { usd: number; updatedAt: number };
  costs: Record<string, Costs & { steps?: Step[] }>;
  decision: Decision;
  plan?: Plan;
  evidence: Evidence[];
  notes: string[];
}

const unit = (lane: Lane, x: bigint) => Number(formatUnits(x, LANE_DECIMALS[lane]));

export async function windows(chain: Chain): Promise<Windows> {
  const now = (await chain.head()) - 2;
  const [d7, d30] = await Promise.all([blockSecondsAgo(chain, now, 7 * 86400), blockSecondsAgo(chain, now, 30 * 86400)]);
  const [tn, t7, t30] = await Promise.all([chain.timestamp(now), chain.timestamp(d7), chain.timestamp(d30)]);
  return { now, d7, d30, secs7: tn - t7, secs30: tn - t30 };
}

export async function look(chain: Chain, a: LookArgs): Promise<Look> {
  const r = new Reader(chain);
  const w = await windows(chain);
  const notes: string[] = [];
  const lane = a.lane;
  const dec = LANE_DECIMALS[lane];
  const places = SOURCES.filter((s) => s.lane === lane);

  // First pass with a nominal amount just to see what the wallet holds where.
  const probeAmount = a.amount ? toUnits(a.amount, dec) : 10n ** BigInt(dec);
  const first = await Promise.all(places.map((s) => readSource(r, s, a.wallet, probeAmount, w)));
  const fromReading = a.from ? first.find((x) => x.source.id === a.from) : [...first].sort((x, y) => (y.held > x.held ? 1 : y.held < x.held ? -1 : 0))[0];
  if (!fromReading) throw new Error(`"${a.from}" is not a ${lane} place dent knows`);

  let amount = a.amount ? toUnits(a.amount, dec) : fromReading.held;
  if (fromReading.source.kind === "idle" && lane === "PROS") {
    const keep = toUnits(String(a.keepPros), 18);
    if (!a.amount || amount > fromReading.held - keep) {
      amount = fromReading.held > keep ? fromReading.held - keep : 0n;
      notes.push(`kept ${a.keepPros} PROS in the wallet to pay gas`);
    }
  }
  if (amount === 0n) notes.push(`nothing to move: the wallet holds no ${lane} in ${fromReading.source.name}`);
  if (amount > fromReading.held) notes.push(`the wallet holds ${unit(lane, fromReading.held)} in ${fromReading.source.name}; the plan for ${unit(lane, amount)} is a what-if and its exit can't be simulated`);

  // Second pass with the real amount, so "rate with you" is for this exact amount.
  const readings = amount === probeAmount ? first : await Promise.all(places.map((s) => (s.id === fromReading.source.id ? Promise.resolve(fromReading) : readSource(r, s, a.wallet, amount, w))));
  const from = readings.find((x) => x.source.id === fromReading.source.id)!;

  const gasPrice = await chain.gasPrice();
  r.evidence.push({ what: "gas price", contract: "node", call: "eth_gasPrice", block: "latest", value: gasPrice.toString() });
  let prosUsd: Look["prosUsd"];
  if (lane === "USDC") {
    const rd = await r.read<readonly [bigint, bigint, bigint, bigint, bigint]>("PROS price in USD (Chainlink)", PROS_USD_FEED, feed, "latestRoundData", [], w.now);
    const fd = await r.read<number>("PROS/USD feed decimals", PROS_USD_FEED, feed, "decimals", [], w.now);
    prosUsd = { usd: Number(formatUnits(rd[1], fd)), updatedAt: Number(rd[3]) };
  }
  const gasToLane = (g: bigint) => {
    const pros = Number(formatUnits(g * gasPrice, 18));
    return lane === "PROS" ? pros : pros * prosUsd!.usd;
  };

  const costs: Look["costs"] = {};
  const stUnbond = readings.find((x) => x.source.kind === "stpros")?.waitSeconds ?? 86400;
  if (amount > 0n) {
    await Promise.all(
      readings
        .filter((x) => x.source.id !== from.source.id && x.status === "open")
        .map(async (to) => {
          try {
            const steps = buildSteps(from, to, a.wallet, amount);
            const est = await estimateAll(chain, a.wallet, steps);
            // Out of a Faroo vault the money is stPROS: into stPROS there's no wait, anywhere else it unbonds first.
            const waitSeconds = from.source.kind === "faroo-vault" ? (to.source.kind === "stpros" ? 0 : stUnbond) : undefined;
            costs[to.source.id] = est.total === undefined ? { gasWhy: est.problem, steps, waitSeconds } : { gas: gasToLane(est.total), steps, waitSeconds };
          } catch (e) {
            costs[to.source.id] = { gasWhy: (e as Error).message };
          }
        }),
    );
  }

  const asPlace = (x: Reading): Place => ({
    id: x.source.id,
    name: x.source.name,
    status: x.status,
    why: x.why,
    fixedRate: x.fixedRate,
    rateNow: x.rateNow,
    rateWithYou: x.rateWithYou,
    realized7d: x.realized7d,
    realized30d: x.realized30d,
    entryFee: x.entryFee,
    exitFee: x.exitFee,
    exitRoom: x.exitRoom === undefined ? undefined : unit(lane, x.exitRoom),
    exitBlocked: x.exitBlocked,
    entryRoom: x.entryRoom === undefined ? undefined : unit(lane, x.entryRoom),
    waitSeconds: x.waitSeconds,
  });
  const decision =
    amount === 0n
      ? { ...decide({ from: asPlace(from), amount: 0, places: [], costs: {}, holdDays: a.holdDays, minGain: a.minGain }), reason: notes[notes.length - 1] }
      : decide({ from: asPlace(from), amount: unit(lane, amount), places: readings.map(asPlace), costs, holdDays: a.holdDays, minGain: a.minGain });

  let plan: Plan | undefined;
  if (decision.action === "MOVE" && decision.to) {
    plan = {
      tool: "dent",
      createdAt: new Date().toISOString(),
      chainId: 1672,
      wallet: a.wallet,
      lane,
      from: from.source.id,
      to: decision.to,
      amount: amount.toString(),
      holdDays: a.holdDays,
      minGain: a.minGain,
      waitSeconds: costs[decision.to].waitSeconds ?? from.waitSeconds,
      steps: costs[decision.to].steps!,
    };
  }

  return {
    block: w.now,
    at: new Date((await chain.timestamp(w.now)) * 1000).toISOString(),
    windows: w,
    lane,
    wallet: a.wallet,
    readings,
    gasPriceWei: gasPrice.toString(),
    prosUsd,
    costs,
    decision,
    plan,
    evidence: r.evidence,
    notes,
  };
}

export function toUnits(x: string, dec: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(x)) throw new Error(`"${x}" is not an amount`);
  const [i, f = ""] = x.split(".");
  return BigInt(i) * 10n ** BigInt(dec) + BigInt((f + "0".repeat(dec)).slice(0, dec) || "0");
}
