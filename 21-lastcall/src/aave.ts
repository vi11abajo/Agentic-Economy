// Reading one wallet's position in an Aave V3 fork (Avalon, OpenFi, Zona). The pool hands us the total health
// factor in one call, but a watchdog that wants to say "repay 50,000 USDC" or "add 0.8 FBTC" needs every
// reserve the wallet touches, priced by the pool's own oracle, plus the rates on both sides.
import type { Hex } from "viem";
import { aaveOracle, aavePool, aaveProvider, erc20, rateStrategy, stableDebt } from "./abis.js";
import type { Chain } from "./chain.js";
import type { Sample } from "./clock.js";
import { priceShape, type Leg, type Snapshot } from "./health.js";
import { ask, rayToApr, tokenInfo, type At } from "./read.js";
import type { AavePool } from "./venues.js";

export interface AaveWiring {
  provider: Hex;
  oracle: Hex;
  configurator: Hex;
  /** Whoever owns the addresses provider: the hand that can change the pool's rules. */
  owner: Hex | null;
}

const wiringCache = new Map<string, AaveWiring>();

export async function aaveWiring(chain: Chain, pool: Hex, at: At = "latest"): Promise<AaveWiring> {
  const key = `${pool}:${at}`;
  const hit = wiringCache.get(key);
  if (hit) return hit;
  const provider = await ask<Hex>(chain, "pool's addresses provider", pool, aavePool, "ADDRESSES_PROVIDER", [], at);
  const [oracle, configurator] = await Promise.all([
    ask<Hex>(chain, "price oracle", provider, aaveProvider, "getPriceOracle", [], at),
    ask<Hex>(chain, "pool configurator", provider, aaveProvider, "getPoolConfigurator", [], at),
  ]);
  let owner: Hex | null = null;
  try {
    owner = await ask<Hex>(chain, "provider owner", provider, aaveProvider, "owner", [], at);
  } catch {
    owner = null;
  }
  const w = { provider, oracle, configurator, owner };
  wiringCache.set(key, w);
  return w;
}

interface ReserveData {
  configuration: bigint;
  currentLiquidityRate: bigint;
  currentVariableBorrowRate: bigint;
  currentStableBorrowRate: bigint;
  id: number;
  aTokenAddress: Hex;
  stableDebtTokenAddress: Hex;
  variableDebtTokenAddress: Hex;
  interestRateStrategyAddress: Hex;
  unbacked: bigint;
}

/** Borrow APR the reserve would charge if every spare unit of cash were borrowed or withdrawn. */
async function stressBorrowApr(chain: Chain, asset: Hex, rd: ReserveData, at: At): Promise<number | undefined> {
  try {
    const [cash, varDebt, stDebt] = await Promise.all([
      ask<bigint>(chain, "cash", asset, erc20, "balanceOf", [rd.aTokenAddress], at),
      ask<bigint>(chain, "variable debt", rd.variableDebtTokenAddress, erc20, "totalSupply", [], at).catch(() => 0n),
      ask<bigint>(chain, "stable debt", rd.stableDebtTokenAddress, erc20, "totalSupply", [], at).catch(() => 0n),
    ]);
    const avgStable = stDebt > 0n ? await ask<bigint>(chain, "avg stable rate", rd.stableDebtTokenAddress, stableDebt, "getAverageStableRate", [], at) : 0n;
    const r = await ask<readonly [bigint, bigint, bigint]>(chain, "rate at full use", rd.interestRateStrategyAddress, rateStrategy, "calculateInterestRates", [
      {
        unbacked: rd.unbacked,
        liquidityAdded: 0n,
        liquidityTaken: cash,
        totalStableDebt: stDebt,
        totalVariableDebt: varDebt,
        averageStableBorrowRate: avgStable,
        reserveFactor: (rd.configuration >> 64n) & 0xffffn,
        reserve: asset,
        aToken: rd.aTokenAddress,
      },
    ], at);
    return rayToApr(r[2]);
  } catch {
    // Some strategy versions take a different struct; then we just don't have a stress figure.
    return undefined;
  }
}

export interface AaveRead {
  snap: Snapshot;
  wiring: AaveWiring;
}

/** The wallet's position in one pool, or null when it owes nothing there. */
export async function readAave(chain: Chain, p: AavePool, wallet: Hex, at: At, samples: Sample[]): Promise<AaveRead | null> {
  const account = await ask<readonly bigint[]>(chain, `${p.name} account data`, p.pool, aavePool, "getUserAccountData", [wallet], at);
  if (account[1] === 0n) return null;
  const wiring = await aaveWiring(chain, p.pool, at);
  const [reserves, userCfg, unit] = await Promise.all([
    ask<readonly Hex[]>(chain, `${p.name} reserves`, p.pool, aavePool, "getReservesList", [], at),
    ask<{ data: bigint }>(chain, `${p.name} user config`, p.pool, aavePool, "getUserConfiguration", [wallet], at),
    ask<bigint>(chain, "oracle base unit", wiring.oracle, aaveOracle, "BASE_CURRENCY_UNIT", [], at).catch(() => 10n ** 8n),
  ]);
  const collateral: Leg[] = [];
  const debt: Leg[] = [];
  await Promise.all(reserves.map(async (asset) => {
    const rd = await ask<ReserveData>(chain, `${p.name} reserve ${asset}`, p.pool, aavePool, "getReserveData", [asset], at);
    const [aBal, vBal, sBal] = await Promise.all([
      ask<bigint>(chain, "aToken balance", rd.aTokenAddress, erc20, "balanceOf", [wallet], at),
      ask<bigint>(chain, "variable debt balance", rd.variableDebtTokenAddress, erc20, "balanceOf", [wallet], at),
      ask<bigint>(chain, "stable debt balance", rd.stableDebtTokenAddress, erc20, "balanceOf", [wallet], at).catch(() => 0n),
    ]);
    if (aBal === 0n && vBal === 0n && sBal === 0n) return;
    const info = await tokenInfo(chain, asset);
    const price = await ask<bigint>(chain, `price of ${info.symbol}`, wiring.oracle, aaveOracle, "getAssetPrice", [asset], at);
    const toValue = (amt: bigint) => (Number(amt) / 10 ** info.decimals) * (Number(price) / Number(unit));
    const history = await Promise.all(
      samples.map(async (s) => ({ time: s.time, price: Number(await ask<bigint>(chain, "past price", wiring.oracle, aaveOracle, "getAssetPrice", [asset], s.block).catch(() => 0n)) })),
    );
    const shape = priceShape(history.filter((h) => h.price > 0));
    // userConfiguration: bit 2*id is "borrowing", bit 2*id+1 is "used as collateral".
    const usedAsCollateral = ((userCfg.data >> BigInt(rd.id * 2 + 1)) & 1n) === 1n;
    if (aBal > 0n) {
      collateral.push({
        token: asset, ...info, amount: aBal, value: toValue(aBal),
        lt: usedAsCollateral ? Number((rd.configuration >> 16n) & 0xffffn) / 1e4 : 0,
        apr: rayToApr(rd.currentLiquidityRate), priceShape: shape.shape, trendApr: shape.trendApr,
      });
    }
    const owedRaw = vBal + sBal;
    if (owedRaw > 0n) {
      const apr = (Number(vBal) * rayToApr(rd.currentVariableBorrowRate) + Number(sBal) * rayToApr(rd.currentStableBorrowRate)) / Number(owedRaw);
      debt.push({
        token: asset, ...info, amount: owedRaw, value: toValue(owedRaw), lt: 0,
        apr, stressApr: await stressBorrowApr(chain, asset, rd, at), priceShape: shape.shape, trendApr: shape.trendApr,
      });
    }
  }));
  // Stable order regardless of which read came back first.
  collateral.sort((a, b) => b.value - a.value);
  debt.sort((a, b) => b.value - a.value);
  const block = at === "latest" ? await chain.head() : at;
  const snap: Snapshot = {
    kind: "aave", venue: p.name, where: p.pool, wallet, block, time: await chain.timestamp(block), quote: "USD",
    hf: Number(account[5]) / 1e18, collateral, debt,
  };
  return { snap, wiring };
}
