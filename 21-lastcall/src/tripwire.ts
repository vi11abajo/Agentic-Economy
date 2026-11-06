// The rules can move under a position without its health factor twitching first: a new interest-rate strategy,
// a lower liquidation threshold, a different price source. On Pharos' Aave forks those changes come from an admin
// multisig straight to the pool configurator, with no timelock in between (Avalon's Safe swapped the USDC rate
// strategy on 2026-11-06 that way). So we can't warn "before", but we can catch it in the very block it lands and
// say what it did to THIS position: health, borrow rate and days left, before vs after.
import { keccak256, toHex, type Hex } from "viem";
import { safe } from "./abis.js";
import type { Chain, Log } from "./chain.js";
import { maybe } from "./read.js";

const SIGNATURES = [
  // Aave V3 PoolConfigurator
  "ReserveInterestRateStrategyChanged(address,address,address)",
  "CollateralConfigurationChanged(address,uint256,uint256,uint256)",
  "ReserveFactorChanged(address,uint256,uint256)",
  "ReserveBorrowing(address,bool)",
  "ReserveFrozen(address,bool)",
  "ReservePaused(address,bool)",
  "ReserveActive(address,bool)",
  "ReserveDropped(address)",
  "BorrowCapChanged(address,uint256,uint256)",
  "SupplyCapChanged(address,uint256,uint256)",
  "LiquidationProtocolFeeChanged(address,uint256,uint256)",
  "EModeAssetCategoryChanged(address,uint8,uint8)",
  "EModeCategoryAdded(uint8,uint256,uint256,uint256,address,string)",
  "DebtCeilingChanged(address,uint256,uint256)",
  // AaveOracle
  "AssetSourceUpdated(address,address)",
  "FallbackOracleUpdated(address)",
  // PoolAddressesProvider
  "PriceOracleUpdated(address,address)",
  "PoolConfiguratorUpdated(address,address)",
  "PoolUpdated(address,address)",
  "AddressSet(bytes32,address,address)",
  "OwnershipTransferred(address,address)",
  // Gnosis Safe: an owner pre-approving a hash on chain is the one early hint a Safe can give
  "ApproveHash(bytes32,address)",
  "ExecutionSuccess(bytes32,uint256)",
  "ExecutionFailure(bytes32,uint256)",
  "SafeMultiSigTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes,bytes)",
  "ChangedThreshold(uint256)",
  "AddedOwner(address)",
  "RemovedOwner(address)",
];

export const EVENT_NAMES = new Map<string, string>(SIGNATURES.map((s) => [keccak256(toHex(s)).toLowerCase(), s.split("(")[0]]));

// Events that are only the multisig's own paperwork around a change; we show them but they don't change a rule.
const PAPERWORK = new Set(["ExecutionSuccess", "SafeMultiSigTransaction", "ExecutionFailure"]);

export interface RuleEvent {
  name: string;
  emitter: Hex;
  /** First indexed address, which for the configurator events is the reserve's asset. */
  subject: Hex | null;
  block: number;
  tx: Hex;
}

export const isRuleChange = (e: RuleEvent) => !PAPERWORK.has(e.name);

export function decodeRuleLog(l: Log): RuleEvent {
  const name = EVENT_NAMES.get(l.topics[0]?.toLowerCase() ?? "") ?? `unknown event ${l.topics[0]?.slice(0, 10)}`;
  const t1 = l.topics[1];
  const subject = t1 && /^0x0{24}/.test(t1) ? (`0x${t1.slice(26)}` as Hex) : null;
  return { name, emitter: l.address, subject, block: l.blockNumber, tx: l.transactionHash };
}

/** Logs from the watched admin contracts in [from, to], walked in the node's 999-block windows. */
export async function ruleEvents(chain: Chain, watched: Hex[], from: number, to: number): Promise<RuleEvent[]> {
  const out: RuleEvent[] = [];
  for (let a = from; a <= to; a += 999) {
    const b = Math.min(to, a + 998);
    const logs = await chain.logs({ from: a, to: b, address: watched });
    out.push(...logs.map(decodeRuleLog));
  }
  return out;
}

/** Who holds the pen: "Safe 3 of 5", "timelock, 2 days", "a plain wallet" or "a contract". */
export async function describeKeys(chain: Chain, owner: Hex | null): Promise<string> {
  if (!owner) return "owner not readable";
  const [threshold, owners, delay] = await Promise.all([
    maybe<bigint>(chain, owner, safe, "getThreshold"),
    maybe<readonly Hex[]>(chain, owner, safe, "getOwners"),
    maybe<bigint>(chain, owner, safe, "getMinDelay"),
  ]);
  if (threshold !== null && owners) return `Safe ${owner}, ${threshold} of ${owners.length} signers, no timelock in front`;
  if (delay !== null) return `timelock ${owner}, ${Number(delay) / 3600} h delay`;
  return `${owner} (answers neither as a Safe nor as a timelock)`;
}
