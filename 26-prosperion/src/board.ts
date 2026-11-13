// Every Prosper market at once, read on chain at one block: phase, PROS in the curve against the 20,000 target, and
// when the window closes. Prosper's API only supplies the list of addresses (names included); the watcher's own list
// only knows launches since it started, which is how the agent once said "only two launches are open" with 17 open.
import { getAddress, parseAbi, type Address } from "viem";
import { client } from "./chain.js";
import type { VaultListing } from "./prosperApi.js";
import type { TradeBook } from "./trades.js";

const marketAbi = parseAbi([
  "function phase() view returns (uint8)",
  "function realWrappedNativeReserve() view returns (uint256)",
  "function targetRaiseNative() view returns (uint256)",
  "function endsAt() view returns (uint256)",
]);
export const PHASE: Record<number, string> = { 0: "on curve", 2: "graduated", 3: "failed" };

export interface BoardEntry {
  symbol: string;
  token: string;
  vaultName: string;
  market: Address;
  pToken: Address;
  vault: Address;
  phase: number;
  phaseName: string;
  prosInCurve: bigint;
  target: bigint;
  /** prosInCurve / target, in basis points */
  progressBps: number;
  endsAt: number;
  /** hours until the window closes; negative once it has */
  hoursLeft: number;
  /** from Prosperion's trade index, when it covers this market */
  buyers?: number;
  holders?: number;
}
export type BoardFilter = "curve" | "graduated" | "failed" | "all";

/** Pure: filter and order. Open markets by how close they are to graduating; the rest newest window first. */
export function rankBoard(entries: BoardEntry[], filter: BoardFilter, limit: number): BoardEntry[] {
  const want = { curve: [0], graduated: [2], failed: [3], all: [0, 2, 3] }[filter];
  return entries
    .filter((e) => want.includes(e.phase))
    .sort((a, b) => (a.phase === 0 && b.phase === 0
      ? (b.prosInCurve > a.prosInCurve ? 1 : b.prosInCurve < a.prosInCurve ? -1 : a.endsAt - b.endsAt)
      : a.phase !== b.phase ? a.phase - b.phase : b.endsAt - a.endsAt))
    .slice(0, limit);
}

export async function readBoard(rows: VaultListing[], book?: TradeBook) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const { timestamp } = await client.getBlock({ blockNumber: block });
  const fns = ["phase", "realWrappedNativeReserve", "targetRaiseNative", "endsAt"] as const;
  const res = await client.multicall({
    blockNumber: block, allowFailure: true,
    contracts: rows.flatMap((r) => fns.map((fn) => ({ address: r.market, abi: marketAbi, functionName: fn }))),
  });
  const entries: BoardEntry[] = [];
  rows.forEach((r, i) => {
    const [ph, rv, tg, end] = res.slice(i * 4, i * 4 + 4);
    if (ph.status !== "success" || rv.status !== "success") return;
    const phase = Number(ph.result), prosInCurve = rv.result as bigint, target = (tg.result as bigint | undefined) ?? 0n;
    const endsAt = Number((end.result as bigint | undefined) ?? 0n);
    const s = book?.summary(r.market);
    entries.push({
      symbol: r.pVaultSymbol, token: (r as VaultListing & { pVaultName?: string }).pVaultName ?? r.pVaultSymbol, vaultName: r.vaultName,
      market: getAddress(r.market), pToken: getAddress(r.pToken), vault: getAddress(r.r25Vault), phase, phaseName: PHASE[phase] ?? `phase ${phase}`,
      prosInCurve, target, progressBps: target ? Number((prosInCurve * 10_000n) / target) : 0,
      endsAt, hoursLeft: Math.round(((endsAt - Number(timestamp)) / 3600) * 10) / 10,
      ...(s && s.buys + s.sells > 0 ? { buyers: s.buyers, holders: s.holdersFromCurve.length } : {}),
    });
  });
  return { block, time: new Date(Number(timestamp) * 1000).toISOString(), entries };
}

const shareValueAbi = parseAbi(["function convertToAssets(uint256) view returns (uint256)", "function totalSupply() view returns (uint256)"]);

/**
 * Prosper's own words about a vault (curator, fees, strategy, AUM, APY), labelled as such, next to the share price
 * read on chain at one block so the API's NAV can be checked against it.
 */
export function profileFrom(d: import("./prosperApi.js").VaultDetail, onChain: { block: bigint; navPerShareUsdc: bigint }) {
  const x = d.r25Display ?? {};
  const bps = (v?: number) => (v === undefined ? null : `${v / 100}%`);
  return {
    vault: getAddress(d.r25Vault), name: d.vaultName,
    fromProsperApi: {
      note: "Prosper's API, not read on chain. Fees and curator are what Prosper publishes.",
      curator: x.curator?.address ?? null, curatorName: x.curator?.name ?? null,
      managementFee: bps(x.managementFeeRateBps), performanceFee: bps(x.performanceFeeRateBps),
      depositFee: bps(x.depositFeeRateBps), withdrawalFee: bps(x.withdrawalFeeRateBps),
      launchpadShareOfPerformanceFee: x.launchpadPerformanceFeeSharePercent ? `${x.launchpadPerformanceFeeSharePercent}%` : null,
      withdrawalProcessingDays: x.withdrawalProcessingDays ?? null, subscriptionSettlement: x.subscriptionSettlement ?? null,
      minimumDepositUsdc: x.minimumDepositUsdc ?? null,
      nav: x.currentNav ?? null, aumUsdc: x.currentAum ?? null, apyPercent: x.apy ?? null, returnPercent: x.performanceReturn ?? null,
      shareHolders: x.currentShareHolders ?? null, everParticipated: x.historicalParticipants ?? null,
      strategy: x.strategyDescription ?? null, declaredPositions: x.assetPositions?.map((p) => `${p.symbol} ${p.weight}%`) ?? [],
      apiIndexedThroughBlock: x.indexedThroughBlock ?? null,
    },
    onChain: { block: onChain.block, navPerShareUsdc: onChain.navPerShareUsdc, how: "vault.convertToAssets(1e18 shares), USDC with 6 decimals" },
  };
}

export async function readVaultProfile(vault: Address, detail: (v: Address) => Promise<import("./prosperApi.js").VaultDetail>) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const [d, nav] = await Promise.all([
    detail(vault),
    client.readContract({ address: vault, abi: shareValueAbi, functionName: "convertToAssets", args: [10n ** 18n], blockNumber: block }),
  ]);
  return profileFrom(d, { block, navPerShareUsdc: nav });
}
