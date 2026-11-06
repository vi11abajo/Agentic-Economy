// Would the rule have paid? Replay it on the chain's own history: at each checkpoint read every place as it was
// at that block (Pharos answers eth_call at old blocks), let the same decide() choose, then let the money grow by
// what the chosen place actually paid until the next checkpoint. Compare with parking the money in one place
// the whole time.
import { formatUnits } from "viem";
import { blockSecondsAgo, type Chain } from "./chain.js";
import { decide, type Costs, type Place } from "./decide.js";
import { erc4626 } from "./abis.js";
import { aavePool } from "./abis.js";
import { sharePrice, state } from "./morpho.js";
import { buildSteps, estimateAll } from "./plan.js";
import { Reader } from "./reads.js";
import { readSource, type Reading, type Windows } from "./sources.js";
import { LANE_DECIMALS, SOURCES, STPROS, type Lane, type Source } from "./venues.js";
import { toUnits } from "./look.js";

export interface BacktestArgs {
  lane: Lane;
  amount: string;
  start: string;
  days: number;
  every: number;
  holdDays: number;
  minGain: number;
  /** Any address with no positions; reads of "the wallet's" balances come back 0, which is what we want. */
  wallet: string;
}

export interface Checkpoint {
  block: number;
  at: string;
  in: string;
  value: number;
  action: "MOVE" | "STAY PUT";
  to?: string;
  reason: string;
}

export interface Backtest {
  lane: Lane;
  from: string;
  to: string;
  checkpoints: Checkpoint[];
  rule: { end: number; moves: number; gasPaid: number };
  parked: { id: string; name: string; end: number }[];
  gasBasis: string;
  notes: string[];
}

const DAY = 86400;

/** The number a place's value grows with: an income index, a share price, or 1 for the wallet. */
async function priceAt(r: Reader, s: Source, block: number): Promise<bigint> {
  switch (s.kind) {
    case "idle":
      return 10n ** 18n;
    case "aave":
      return r.read<bigint>(`${s.name}: income index`, s.address!, aavePool, "getReserveNormalizedIncome", [s.asset], block);
    case "morpho-market":
      return sharePrice(await state(r, s.marketId!, block));
    case "vault":
    case "stpros":
      return r.read<bigint>(`${s.name}: share price`, s.address!, erc4626, "convertToAssets", [10n ** 18n], block);
    case "faroo-vault": {
      const st = await r.read<bigint>(`${s.name}: stPROS per share`, s.address!, erc4626, "convertToAssets", [10n ** 24n], block);
      return r.read<bigint>(`${s.name}: in PROS`, STPROS, erc4626, "convertToAssets", [st], block);
    }
  }
}

async function windowsAt(chain: Chain, block: number): Promise<Windows> {
  const [d7, d30] = await Promise.all([blockSecondsAgo(chain, block, 7 * DAY), blockSecondsAgo(chain, block, 30 * DAY)]);
  const [t, t7, t30] = await Promise.all([chain.timestamp(block), chain.timestamp(d7), chain.timestamp(d30)]);
  return { now: block, d7, d30, secs7: t - t7, secs30: t - t30 };
}

const asPlace = (x: Reading, lane: Lane): Place => ({
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
  exitRoom: x.exitRoom === undefined ? undefined : Number(formatUnits(x.exitRoom, LANE_DECIMALS[lane])),
  entryRoom: x.entryRoom === undefined ? undefined : Number(formatUnits(x.entryRoom, LANE_DECIMALS[lane])),
  waitSeconds: x.waitSeconds,
});

export async function backtest(chain: Chain, a: BacktestArgs, progress: (s: string) => void = () => {}): Promise<Backtest> {
  const r = new Reader(chain);
  const lane = a.lane;
  const dec = LANE_DECIMALS[lane];
  const places = SOURCES.filter((s) => s.lane === lane);
  const notes: string[] = [];
  const head = (await chain.head()) - 2;

  // Checkpoints from `days` ago to now, every `every` days, by block timestamp.
  const blocks: number[] = [];
  for (let d = a.days; d >= 0; d -= a.every) blocks.push(d === 0 ? head : await blockSecondsAgo(chain, head, d * DAY));
  if (blocks[blocks.length - 1] !== head) blocks.push(head);

  // Gas: the price of each entry today, estimated with storage overrides from an empty wallet. History doesn't
  // keep gas estimates, so the same figure is charged at every checkpoint; leaving a place is charged what
  // entering it costs (stated in the output, it's an assumption).
  const amountUnits = toUnits(a.amount, dec);
  const gasPrice = await chain.gasPrice();
  const wNow = await windowsAt(chain, head);
  const nowReadings = await Promise.all(places.map((s) => readSource(r, s, a.wallet, amountUnits, wNow)));
  const idleNow = nowReadings.find((x) => x.source.kind === "idle")!;
  let prosUsd = 1;
  if (lane === "USDC") {
    const { feed } = await import("./abis.js");
    const { PROS_USD_FEED } = await import("./venues.js");
    const rd = await r.read<readonly [bigint, bigint, bigint, bigint, bigint]>("PROS price in USD", PROS_USD_FEED, feed, "latestRoundData", [], head);
    prosUsd = Number(formatUnits(rd[1], 18));
  }
  const entryGas: Record<string, number> = { [idleNow.source.id]: 0 };
  for (const to of nowReadings) {
    if (to.source.kind === "idle" || to.source.kind === "faroo-vault") continue;
    try {
      const steps = buildSteps({ ...idleNow, held: amountUnits }, to, a.wallet, amountUnits);
      const est = await estimateAll(chain, a.wallet, steps);
      if (est.total !== undefined) entryGas[to.source.id] = Number(formatUnits(est.total * gasPrice, 18)) * (lane === "USDC" ? prosUsd : 1);
    } catch {
      /* no entry plan for this place: it simply can't be chosen */
    }
  }
  const gasBasis = `gas at today's ${formatUnits(gasPrice, 9)} gwei${lane === "USDC" ? ` and PROS = $${prosUsd.toFixed(4)}` : ""}; leaving a place is charged what entering it costs`;

  let where = a.start;
  let value = Number(a.amount);
  let moves = 0;
  let gasPaid = 0;
  const checkpoints: Checkpoint[] = [];
  const parkedStart: Record<string, number> = {};
  const parkedValue: Record<string, number> = {};

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    progress(`checkpoint ${i + 1}/${blocks.length} at block ${b}`);
    const w = await windowsAt(chain, b);
    const readings = await Promise.all(places.map((s) => readSource(r, s, a.wallet, toUnits(value.toFixed(dec), dec), w, { historical: true })));
    const at = new Date((await chain.timestamp(b)) * 1000).toISOString();

    if (i === 0)
      for (const x of readings)
        if (entryGas[x.source.id] !== undefined && x.status === "open") {
          parkedStart[x.source.id] = Number(await priceAt(r, x.source, b));
          parkedValue[x.source.id] = Number(a.amount) - entryGas[x.source.id];
        }

    if (i === blocks.length - 1) {
      checkpoints.push({ block: b, at, in: where, value, action: "STAY PUT", reason: "end of the replay" });
      break;
    }
    const from = readings.find((x) => x.source.id === where)!;
    const costs: Record<string, Costs> = {};
    for (const x of readings) if (x.source.id !== where && entryGas[x.source.id] !== undefined) costs[x.source.id] = { gas: entryGas[x.source.id] + (entryGas[where] ?? 0) };
    const d = decide({ from: asPlace(from, lane), amount: value, places: readings.map((x) => asPlace(x, lane)), costs, holdDays: a.holdDays, minGain: a.minGain });
    checkpoints.push({ block: b, at, in: where, value, action: d.action, to: d.to, reason: d.reason });

    let wait = 0;
    if (d.action === "MOVE" && d.to) {
      const g = costs[d.to].gas!;
      value -= g;
      gasPaid += g;
      moves++;
      wait = from.waitSeconds;
      where = d.to;
    }
    // Let the money grow by what the place actually paid until the next checkpoint.
    const place = SOURCES.find((s) => s.id === where)!;
    const [p0, p1, t0, t1] = await Promise.all([priceAt(r, place, b), priceAt(r, place, blocks[i + 1]), chain.timestamp(b), chain.timestamp(blocks[i + 1])]);
    const growth = p0 > 0n ? Number(p1) / Number(p0) - 1 : 0;
    // Days spent unbonding earn nothing.
    const earning = Math.max(0, 1 - wait / Math.max(1, t1 - t0));
    value *= 1 + growth * earning;
  }

  for (const id of Object.keys(parkedStart)) {
    const s = SOURCES.find((x) => x.id === id)!;
    const end = Number(await priceAt(r, s, blocks[blocks.length - 1]));
    parkedValue[id] = parkedValue[id] * (parkedStart[id] > 0 ? end / parkedStart[id] : 1) - (entryGas[id] ?? 0);
  }
  notes.push("rates and growth are read at each checkpoint's block; positions are what this replay would have held, not a real wallet's");
  if (lane === "PROS") notes.push("unbonding days (stPROS) are counted as earning nothing");

  return {
    lane,
    from: checkpoints[0]?.at ?? "",
    to: checkpoints[checkpoints.length - 1]?.at ?? "",
    checkpoints,
    rule: { end: value, moves, gasPaid },
    parked: Object.keys(parkedValue)
      .map((id) => ({ id, name: SOURCES.find((s) => s.id === id)!.name, end: parkedValue[id] }))
      .sort((x, y) => y.end - x.end),
    gasBasis,
    notes,
  };
}

export function renderBacktest(bt: Backtest, a: BacktestArgs): string {
  const u = bt.lane;
  const f = (x: number) => Number(x.toPrecision(8)).toString();
  const out: string[] = [];
  out.push(`dent backtest  ${u} lane, ${a.amount} ${u} starting in ${a.start}, checkpoint every ${a.every} days, hold ${a.holdDays} days, min gain ${a.minGain}`);
  out.push(`from ${bt.from} to ${bt.to}; ${bt.gasBasis}`);
  out.push("");
  for (const c of bt.checkpoints)
    out.push(`  block ${c.block} ${c.at.slice(0, 16)}  in ${c.in.padEnd(20)} ${f(c.value).padEnd(14)} ${c.action === "MOVE" ? `MOVE -> ${c.to}` : "stay"}${c.action === "MOVE" ? "" : `: ${c.reason}`}`);
  out.push("");
  out.push(`the rule: ends with ${f(bt.rule.end)} ${u} after ${bt.rule.moves} move(s), ${f(bt.rule.gasPaid)} ${u} of it spent on gas`);
  out.push("parked in one place the whole time (entry and exit gas paid once):");
  for (const p of bt.parked) out.push(`  ${p.name.padEnd(36)} ${f(p.end)} ${u}${p.end > bt.rule.end ? "   <- beat the rule" : ""}`);
  for (const n of bt.notes) out.push(`note: ${n}`);
  return out.join("\n");
}
