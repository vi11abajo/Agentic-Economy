// What is really behind a Prosper vault's NAV, read straight from the R25 contracts at one block.
// The vault's NAV oracle adds three things: USDC (and other tokens) sitting in the vault's escrow on Pharos,
// positions held through "Local" adapters on Pharos, and "Mirror" adapters, which are one unit of a made-up asset
// whose price the operator pushes. That last one is a number you have to take on trust, so we split it out.
import { getAddress, parseAbi, type Address } from "viem";
import { client } from "./chain.js";

const abi = parseAbi([
  "function accountant() view returns (address)",
  "function share() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function navOracle() view returns (address)",
  "function escrow() view returns (address)",
  "function adapterRegistry() view returns (address)",
  "function offchainAssetPriceOracle() view returns (address)",
  "function baseAsset() view returns (address)",
  "function positionAssets() view returns (address[])",
  "function activeAssets(address) view returns (uint256)",
  "function priceData(address) view returns ((uint256 price, uint256 timestamp, bytes32 roundId))",
  "function defaultMaxPriceAge() view returns (uint256)",
  "function adapterIds() view returns (bytes32[])",
  "function getAdapterInfo(bytes32) view returns ((address adapter, uint8 kind, uint64 chainId, bool enabled))",
  "function positions() view returns ((uint8 status, uint256 chainId, address asset, uint256 amount, bytes32 refId)[])",
  "function decimals() view returns (uint8)",
]);
type Fn = (typeof abi)[number]["name"];
// The NAV oracle's totalAssets() has the same name as the vault's but returns (amount, valid), so it gets its own ABI.
const oracleNavAbi = parseAbi(["function totalAssets() view returns ((uint256 totalAssets, bool valid))"]);

const KINDS = ["Local", "Mirror", "Remote"] as const;
export type AdapterKind = (typeof KINDS)[number];

export interface VaultPicture {
  vault: Address;
  block: bigint;
  /** In USDC units (6 decimals), as the vault itself reports it. */
  totalAssets: bigint;
  /** The oracle's own flag: false when any price is older than its max age. */
  validNav: boolean;
  escrow: { asset: Address; amount: bigint; value: bigint }[];
  adapters: { adapter: Address; kind: AdapterKind; value: bigint }[];
  /** Share of NAV you can check on Pharos (escrow + Local adapters), in basis points. */
  verifiableBps: number;
  prices: { asset: Address; ageSec: number; stale: boolean }[];
  supply: bigint;
  /** USDC (6 decimals) per one whole share. */
  navPerShare: bigint;
  /** True when our own sum of the parts equals the oracle's totalAssets to the last unit. */
  reconciles: boolean;
}

export function reader(block: bigint) {
  return <T>(address: Address, functionName: Fn, args: readonly unknown[] = []) =>
    client.readContract({ address, abi, functionName, args, blockNumber: block } as never) as Promise<T>;
}

export async function readVault(vault: Address, at?: bigint): Promise<VaultPicture> {
  const block = at ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const rd = reader(block);
  const { timestamp } = await client.getBlock({ blockNumber: block });

  const accountant = await rd<Address>(vault, "accountant");
  const oracle = await rd<Address>(accountant, "navOracle");
  const [escrow, registry, priceOracle, base, totalAssets, supply, nav] = await Promise.all([
    rd<Address>(oracle, "escrow"),
    rd<Address>(oracle, "adapterRegistry"),
    rd<Address>(oracle, "offchainAssetPriceOracle"),
    rd<Address>(oracle, "baseAsset"),
    rd<bigint>(vault, "totalAssets"),
    rd<bigint>(vault, "totalSupply"),
    client.readContract({ address: oracle, abi: oracleNavAbi, functionName: "totalAssets", blockNumber: block }),
  ]);
  const maxAge = await rd<bigint>(priceOracle, "defaultMaxPriceAge");

  const prices: VaultPicture["prices"] = [];
  // Prices are in base units (USDC, 6 decimals) per one whole token.
  const valueOf = async (asset: Address, amount: bigint) => {
    if (amount === 0n) return 0n;
    const p = await rd<{ price: bigint; timestamp: bigint }>(priceOracle, "priceData", [asset]);
    const ageSec = Number(timestamp - p.timestamp);
    prices.push({ asset, ageSec, stale: BigInt(ageSec) > maxAge });
    // Mirror pseudo-assets have no code at all; the adapter books them as 1.0 = 1e6, like USDC.
    const decimals = await rd<number>(asset, "decimals").catch(() => 6);
    return (amount * p.price) / 10n ** BigInt(decimals);
  };

  const escrowParts: VaultPicture["escrow"] = [];
  const baseAmount = await rd<bigint>(escrow, "activeAssets", [base]);
  escrowParts.push({ asset: getAddress(base), amount: baseAmount, value: baseAmount });
  for (const asset of await rd<Address[]>(oracle, "positionAssets")) {
    if (asset.toLowerCase() === base.toLowerCase()) continue;
    const amount = await rd<bigint>(escrow, "activeAssets", [asset]);
    if (amount > 0n) escrowParts.push({ asset: getAddress(asset), amount, value: await valueOf(asset, amount) });
  }

  const adapters: VaultPicture["adapters"] = [];
  for (const id of await rd<`0x${string}`[]>(registry, "adapterIds")) {
    const info = await rd<{ adapter: Address; kind: number; enabled: boolean }>(registry, "getAdapterInfo", [id]);
    if (!info.enabled) continue;
    const positions = await rd<{ asset: Address; amount: bigint }[]>(info.adapter, "positions");
    let value = 0n;
    for (const p of positions) value += await valueOf(p.asset, p.amount);
    adapters.push({ adapter: getAddress(info.adapter), kind: KINDS[info.kind] ?? "Remote", value });
  }

  const onPharos =
    escrowParts.reduce((s, e) => s + e.value, 0n) +
    adapters.filter((a) => a.kind === "Local").reduce((s, a) => s + a.value, 0n);
  const sum = escrowParts.reduce((s, e) => s + e.value, 0n) + adapters.reduce((s, a) => s + a.value, 0n);

  return {
    vault: getAddress(vault),
    block,
    totalAssets,
    validNav: nav.valid,
    escrow: escrowParts,
    adapters,
    verifiableBps: totalAssets === 0n ? 0 : Number((onPharos * 10_000n) / totalAssets),
    prices,
    supply,
    navPerShare: supply === 0n ? 0n : (totalAssets * 10n ** 18n) / supply,
    reconciles: sum === nav.totalAssets,
  };
}
