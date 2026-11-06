// One reading per place money can sit: what the wallet has there, what it pays, what it pays once *your*
// money is in it, what it costs to get in and out, and whether the door is open right now.
import { encodeFunctionData, type Hex } from "viem";
import { aavePool, erc20, erc4626, rateStrategy, stableDebt, stpros } from "./abis.js";
import { Failed, Reader, nativeOverride, tokenOverride } from "./reads.js";
import { MORPHO, morphoAbi, params, sharePrice, state, supplyRate, vaultV2Model, type MarketParams } from "./morpho.js";
import { STPROS, USDC, type Source } from "./venues.js";

/** Blocks we read history at, with the real seconds between them (from block timestamps, not an assumed block time). */
export interface Windows {
  now: number;
  d7: number;
  d30: number;
  secs7: number;
  secs30: number;
}

export interface Reading {
  source: Source;
  status: "open" | "closed" | "unreadable";
  why?: string;
  /** What the wallet has here, in lane units (USDC 6 decimals, PROS 18). */
  held: bigint;
  /** Raw position: shares or aTokens, needed to build the exit. */
  heldShares: bigint;
  /** Earns exactly this in every window (the wallet itself: 0). */
  fixedRate?: number;
  rateNow?: number;
  /** The rate once the amount being moved has landed here (Aave forks only, from the pool's own rate contract). */
  rateWithYou?: number;
  realized7d?: number;
  realized30d?: number;
  entryFee: number;
  exitFee: number;
  /** How much could leave right now (pool cash). Undefined when nothing limits it that we know of. */
  exitRoom?: bigint;
  /** Set when getting out is impossible right now, with the reason. */
  exitBlocked?: string;
  /** How much more the venue accepts (supply cap). */
  entryRoom?: bigint;
  /** Seconds between asking for the money back and having it (stPROS unbonding). */
  waitSeconds: number;
  notes: string[];
  /** Faroo vaults: the stPROS behind the wallet's shares. */
  heldUnderlying?: bigint;
  /** Morpho markets: the market's parameters, which every supply and withdraw call carries. */
  marketParams?: MarketParams;
  /** Aave only: the aToken, for the plan and for reading balances. */
  aToken?: string;
}

const RAY = 10n ** 27n;
const YEAR = 365 * 24 * 3600;
/** Shares used to measure a vault's share price; big enough that a tiny weekly move isn't lost to rounding. */
const PROBE: Record<number, bigint> = { 18: 10n ** 18n, 24: 10n ** 24n, 6: 10n ** 6n };

const toRate = (r: bigint) => Number((r * 1_000_000n) / RAY) / 1_000_000;
/** Simple annualised growth between two values, the way a share price or a liquidity index is quoted. */
export const annualise = (from: bigint, to: bigint, seconds: number) =>
  from > 0n && seconds > 0 ? (Number(((to - from) * 10n ** 12n) / from) / 1e12) * (YEAR / seconds) : 0;

function blank(source: Source): Reading {
  return { source, status: "open", held: 0n, heldShares: 0n, entryFee: 0, exitFee: 0, waitSeconds: 0, notes: [] };
}

export interface ReadOpts {
  /** Reading the past (backtest): no simulations, they can only run against the latest state. */
  historical?: boolean;
}

export async function readSource(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows, o: ReadOpts = {}): Promise<Reading> {
  try {
    switch (source.kind) {
      case "idle":
        return await idle(r, source, wallet, w);
      case "aave":
        return await aave(r, source, wallet, amount, w);
      case "vault":
        return await vault(r, source, wallet, amount, w, o);
      case "stpros":
        return await stPros(r, source, wallet, amount, w, o);
      case "faroo-vault":
        return await farooVault(r, source, wallet, amount, w, o);
      case "morpho-market":
        return await morphoMarket(r, source, wallet, amount, w, o);
    }
  } catch (e) {
    const out = blank(source);
    out.status = "unreadable";
    out.why = e instanceof Failed ? e.reason : (e as Error).message;
    return out;
  }
}

async function idle(r: Reader, source: Source, wallet: string, w: Windows): Promise<Reading> {
  const out = blank(source);
  out.rateNow = 0;
  out.fixedRate = 0;
  if (source.lane === "USDC") {
    out.held = await r.read<bigint>("USDC in the wallet", USDC, erc20, "balanceOf", [wallet], w.now);
  } else {
    out.held = await r.chain.nativeBalance(wallet, w.now);
    r.evidence.push({ what: "PROS in the wallet", contract: wallet, call: "eth_getBalance", block: w.now, value: out.held.toString() });
  }
  out.heldShares = out.held;
  out.notes.push("earns nothing");
  return out;
}

async function aave(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows): Promise<Reading> {
  const out = blank(source);
  const pool = source.address!;
  const asset = source.asset;
  const label = source.name;
  type RD = {
    configuration: bigint;
    currentLiquidityRate: bigint;
    aTokenAddress: string;
    stableDebtTokenAddress: string;
    variableDebtTokenAddress: string;
    interestRateStrategyAddress: string;
    unbacked: bigint;
  };
  const rd = await r.read<RD>(`${label}: reserve data`, pool, aavePool, "getReserveData", [asset], w.now);
  out.aToken = rd.aTokenAddress;
  const cfg = rd.configuration;
  const reserveFactor = (cfg >> 64n) & 0xffffn;
  const decimals = Number((cfg >> 48n) & 0xffn);
  const supplyCap = (cfg >> 116n) & ((1n << 36n) - 1n);

  const [aSupply, cash, varDebt, stDebt, heldA] = await Promise.all([
    r.read<bigint>(`${label}: total supplied`, rd.aTokenAddress, erc20, "totalSupply", [], w.now),
    r.read<bigint>(`${label}: cash in the pool`, asset, erc20, "balanceOf", [rd.aTokenAddress], w.now),
    r.read<bigint>(`${label}: variable debt`, rd.variableDebtTokenAddress, erc20, "totalSupply", [], w.now),
    r.read<bigint>(`${label}: stable debt`, rd.stableDebtTokenAddress, erc20, "totalSupply", [], w.now),
    r.read<bigint>(`${label}: wallet's deposit`, rd.aTokenAddress, erc20, "balanceOf", [wallet], w.now),
  ]);
  let avgStable = 0n;
  if (stDebt > 0n) avgStable = await r.read<bigint>(`${label}: avg stable rate`, rd.stableDebtTokenAddress, stableDebt, "getAverageStableRate", [], w.now);

  out.held = heldA;
  out.heldShares = heldA;
  out.exitRoom = cash;
  if (supplyCap > 0n) {
    const cap = supplyCap * 10n ** BigInt(decimals);
    out.entryRoom = cap > aSupply ? cap - aSupply : 0n;
  }
  out.rateNow = toRate(rd.currentLiquidityRate);
  // Configuration bits 56/57/60 are active/frozen/paused in Aave V3. Read after the balances, so a wallet stuck
  // in a frozen reserve still sees what it has there.
  const bit = (n: bigint) => (cfg >> n) & 1n;
  if (!bit(56n)) return closed(out, "reserve is not active");
  if (bit(60n)) return closed(out, "reserve is paused");
  if (bit(57n)) return closed(out, "reserve is frozen (no new deposits)");

  // The pool's own rate contract, asked "what would you pay if this much more cash came in?"
  const rates = await r.read<readonly [bigint, bigint, bigint]>(
    `${label}: supply rate with ${amount} more`,
    rd.interestRateStrategyAddress,
    rateStrategy,
    "calculateInterestRates",
    [
      {
        unbacked: rd.unbacked,
        liquidityAdded: amount,
        liquidityTaken: 0n,
        totalStableDebt: stDebt,
        totalVariableDebt: varDebt,
        averageStableBorrowRate: avgStable,
        reserveFactor,
        reserve: asset,
        aToken: rd.aTokenAddress,
      },
    ],
    w.now,
  );
  out.rateWithYou = toRate(rates[0]);

  // What depositors actually got: the liquidity index is the running total of supplier interest.
  const idx = async (b: number) => r.read<bigint>(`${label}: supplier income index`, pool, aavePool, "getReserveNormalizedIncome", [asset], b);
  const [iNow, i7, i30] = await Promise.all([idx(w.now), idx(w.d7).catch(() => 0n), idx(w.d30).catch(() => 0n)]);
  if (i7 > 0n) out.realized7d = annualise(i7, iNow, w.secs7);
  if (i30 > 0n) out.realized30d = annualise(i30, iNow, w.secs30);
  out.notes.push("Aave V3 supply and withdraw take no fee");
  return out;
}

async function vault(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows, o: ReadOpts): Promise<Reading> {
  const out = blank(source);
  const v = source.address!;
  const label = source.name;
  const dec = await r.read<number>(`${label}: share decimals`, v, erc4626, "decimals", [], w.now);
  await sharePrices(r, out, v, PROBE[dec] ?? 10n ** BigInt(dec), w);
  const shares = await r.read<bigint>(`${label}: wallet's shares`, v, erc20, "balanceOf", [wallet], w.now);
  out.heldShares = shares;
  out.held = shares > 0n ? await r.read<bigint>(`${label}: wallet's shares in USDC`, v, erc4626, "convertToAssets", [shares], w.now) : 0n;
  await vaultFees(r, out, v, amount > 0n ? amount : 10n ** 6n, shares, w);
  try {
    const m = await vaultV2Model(r, v, amount, w.now);
    out.rateWithYou = m.withYou;
    out.notes.push(
      `rate with you modelled from the ${m.markets} Morpho markets it lends into, after its performance fee: ${(m.now * 100).toFixed(2)}% now, ${(m.withYou * 100).toFixed(2)}% with your deposit; ${(m.idleShare * 100).toFixed(0)}% of the vault sits idle`,
    );
  } catch (e) {
    out.notes.push(`couldn't model its rate with your deposit (${e instanceof Failed ? e.reason : (e as Error).message}); realised rates only`);
  }
  if (o.historical) return out;
  // Is the door open? Hand a fresh copy of the wallet the amount and try the deposit.
  const sim = await r.simulate(
    `${label}: deposit ${amount} would go through`,
    { from: wallet, to: v, data: encodeFunctionData({ abi: erc4626, functionName: "deposit", args: [amount, wallet as Hex] }) },
    tokenOverride(source.asset, wallet, amount, v),
  );
  if (!sim.ok) return closed(out, `deposit reverts: ${sim.why}`);
  if (shares > 0n) {
    const exit = await r.simulate(`${label}: wallet can redeem all its shares`, {
      from: wallet,
      to: v,
      data: encodeFunctionData({ abi: erc4626, functionName: "redeem", args: [shares, wallet as Hex, wallet as Hex] }),
    });
    if (!exit.ok) {
      out.exitRoom = 0n;
      out.notes.push(`leaving now reverts: ${exit.why}`);
    }
  }
  return out;
}

async function stPros(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows, o: ReadOpts): Promise<Reading> {
  const out = blank(source);
  const label = source.name;
  await sharePrices(r, out, STPROS, 10n ** 18n, w);
  const shares = await r.read<bigint>(`${label}: wallet's stPROS`, STPROS, erc20, "balanceOf", [wallet], w.now);
  out.heldShares = shares;
  out.held = shares > 0n ? await r.read<bigint>(`${label}: wallet's stPROS in PROS`, STPROS, erc4626, "convertToAssets", [shares], w.now) : 0n;
  await vaultFees(r, out, STPROS, amount > 0n ? amount : 10n ** 18n, shares, w);
  // Unnamed getter 0x6cf6d675 answers 86400. Recent real redeems were claimed 24-29 h later, so we read it as the
  // unbonding time; if it ever changes, the number shown changes with it.
  out.waitSeconds = Number(await r.readRaw(`${label}: unbonding seconds`, STPROS, "0x6cf6d675", w.now));
  if (o.historical) return out;
  const stake = await r.simulate(
    `${label}: staking ${amount} wei would go through`,
    { from: wallet, to: STPROS, data: encodeFunctionData({ abi: stpros, functionName: "depositWithPROS" }), value: amount },
    nativeOverride(wallet, amount + 10n ** 18n),
  );
  if (!stake.ok) return closed(out, `staking reverts: ${stake.why}`);
  out.notes.push(`leaving: redeem, wait ${(out.waitSeconds / 3600).toFixed(0)} h, then claim; nothing is earned while waiting`);
  return out;
}

async function farooVault(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows, o: ReadOpts): Promise<Reading> {
  const out = blank(source);
  const v = source.address!;
  const label = source.name;
  // In PROS a vault share is worth (stPROS per share) x (PROS per stPROS), so its rate rides stPROS's rate too.
  const probe = 10n ** 24n;
  const inPros = async (b: number) => {
    const st = await r.read<bigint>(`${label}: stPROS per share`, v, erc4626, "convertToAssets", [probe], b);
    return r.read<bigint>(`${label}: that stPROS in PROS`, STPROS, erc4626, "convertToAssets", [st], b);
  };
  const [now, p7, p30] = await Promise.all([inPros(w.now), inPros(w.d7).catch(() => 0n), inPros(w.d30).catch(() => 0n)]);
  if (p7 > 0n) out.realized7d = annualise(p7, now, w.secs7);
  if (p30 > 0n) out.realized30d = annualise(p30, now, w.secs30);
  out.rateNow = out.realized7d;
  out.notes.push("a Faroo vault holds stPROS, so in PROS it earns stPROS's rate plus its own");
  const shares = await r.read<bigint>(`${label}: wallet's shares`, v, erc20, "balanceOf", [wallet], w.now);
  out.heldShares = shares;
  if (shares > 0n) {
    const st = await r.read<bigint>(`${label}: wallet's shares in stPROS`, v, erc4626, "convertToAssets", [shares], w.now);
    out.heldUnderlying = st;
    out.held = await r.read<bigint>(`${label}: that stPROS in PROS`, STPROS, erc4626, "convertToAssets", [st], w.now);
  }
  out.status = "closed";
  out.why = "dent plans only exits from Faroo vaults (they take stPROS, not PROS)";
  if (o.historical) return out;
  // These vaults go through phases. Deposit and redeem are tried separately: one can be open while the other isn't.
  const stAmount = amount > 0n ? amount : 10n ** 18n;
  const dep = await r.simulate(
    `${label}: deposit would go through`,
    { from: wallet, to: v, data: encodeFunctionData({ abi: erc4626, functionName: "deposit", args: [stAmount, wallet as Hex] }) },
    tokenOverride(STPROS, wallet, stAmount, v),
  );
  if (!dep.ok) out.why = `deposit reverts: ${dep.why}`;
  if (shares > 0n) {
    const red = await r.simulate(`${label}: wallet can redeem its shares`, {
      from: wallet,
      to: v,
      data: encodeFunctionData({ abi: erc4626, functionName: "redeem", args: [shares, wallet as Hex, wallet as Hex] }),
    });
    if (!red.ok) out.exitBlocked = `redeem reverts: ${red.why}`;
    else out.notes.push("redeeming your shares goes through right now");
  }
  return out;
}

async function morphoMarket(r: Reader, source: Source, wallet: string, amount: bigint, w: Windows, o: ReadOpts): Promise<Reading> {
  const out = blank(source);
  const id = source.marketId!;
  const mp = await params(r, id, w.now);
  out.marketParams = mp;
  const m = await state(r, id, w.now);
  out.rateNow = await supplyRate(r, id, mp, m, 0n, w.now);
  out.rateWithYou = await supplyRate(r, id, mp, m, amount, w.now);
  const past = async (b: number) => sharePrice(await state(r, id, b));
  const [p7, p30] = await Promise.all([past(w.d7).catch(() => 0n), past(w.d30).catch(() => 0n)]);
  const pNow = sharePrice(m);
  if (p7 > 0n) out.realized7d = annualise(p7, pNow, w.secs7);
  if (p30 > 0n) out.realized30d = annualise(p30, pNow, w.secs30);
  out.exitRoom = m.totalSupplyAssets - m.totalBorrowAssets;
  const pos = await r.read<readonly [bigint, bigint, bigint]>(`${source.name}: wallet's position`, MORPHO, morphoAbi, "position", [id, wallet], w.now);
  out.heldShares = pos[0];
  out.held = m.totalSupplyShares > 0n ? (pos[0] * m.totalSupplyAssets) / m.totalSupplyShares : 0n;
  out.notes.push("Morpho markets take no supply or withdraw fee; their realised rate moves only when someone touches the market");
  if (source.note) out.notes.push(source.note);
  if (o.historical) return out;
  const sim = await r.simulate(
    `${source.name}: supply ${amount} would go through`,
    { from: wallet, to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: "supply", args: [mp, amount, 0n, wallet as Hex, "0x"] }) },
    tokenOverride(source.asset, wallet, amount, MORPHO),
  );
  if (!sim.ok) return closed(out, `supply reverts: ${sim.why}`);
  return out;
}

async function sharePrices(r: Reader, out: Reading, v: string, probe: bigint, w: Windows) {
  const p = (b: number) => r.read<bigint>(`${out.source.name}: share price`, v, erc4626, "convertToAssets", [probe], b);
  const [now, p7, p30] = await Promise.all([p(w.now), p(w.d7).catch(() => 0n), p(w.d30).catch(() => 0n)]);
  if (p7 > 0n) out.realized7d = annualise(p7, now, w.secs7);
  if (p30 > 0n) out.realized30d = annualise(p30, now, w.secs30);
  out.rateNow = out.realized7d;
}

async function vaultFees(r: Reader, out: Reading, v: string, assets: bigint, shares: bigint, w: Windows) {
  const label = out.source.name;
  const [fair, preview] = await Promise.all([
    r.read<bigint>(`${label}: shares for ${assets} at the share price`, v, erc4626, "convertToShares", [assets], w.now),
    r.read<bigint>(`${label}: shares a deposit of ${assets} would mint`, v, erc4626, "previewDeposit", [assets], w.now),
  ]);
  out.entryFee = fair > 0n && preview < fair ? Number(((fair - preview) * 1_000_000n) / fair) / 1_000_000 : 0;
  const s = shares > 0n ? shares : fair;
  const [worth, paid] = await Promise.all([
    r.read<bigint>(`${label}: value of ${s} shares`, v, erc4626, "convertToAssets", [s], w.now),
    r.read<bigint>(`${label}: what redeeming ${s} shares pays`, v, erc4626, "previewRedeem", [s], w.now),
  ]);
  out.exitFee = worth > 0n && paid < worth ? Number(((worth - paid) * 1_000_000n) / worth) / 1_000_000 : 0;
}

function closed(out: Reading, why: string): Reading {
  out.status = "closed";
  out.why = why;
  return out;
}
