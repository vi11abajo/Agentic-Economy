// Why did NAV per share move between two blocks? NAV per share = assets / shares, so it moves when either side does.
// We list every block where shares were minted or burned and look at assets in that same block:
//   - assets moved too: money came in or went out (a settled deposit or redeem), "flows";
//   - shares burned with no money moving: somebody with admin rights destroyed shares, "admin";
//   - shares minted with no money moving: fee shares, "fees".
// Whatever the Mirror adapter's reported value did is "mirror", and the rest of the asset change is "price".
import { parseAbiItem, type Address, type Hex } from "viem";
import { client } from "./chain.js";
import { readVault, reader } from "./vault.js";

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
const ZERO = "0x0000000000000000000000000000000000000000";
// The public node caps eth_getLogs at 1,000 blocks; we stop at about 14 hours so one question cannot eat the RPC.
const LOG_SPAN = 1000n;
export const MAX_SPAN = 50_000n;

export type PartKind = "flows" | "price" | "fees" | "admin" | "mirror";
export interface NavPart {
  kind: PartKind;
  /** "usdc" parts are asset changes (6 decimals), "shares" parts are supply changes (18 decimals). */
  unit: "usdc" | "shares";
  delta: bigint;
  txs: Hex[];
}
export interface NavMove {
  from: bigint;
  to: bigint;
  navFrom: bigint;
  navTo: bigint;
  assetsDelta: bigint;
  supplyDelta: bigint;
  parts: NavPart[];
}

export async function explainNavMove(vault: Address, from: bigint, to: bigint): Promise<NavMove> {
  if (to <= from) throw new Error("toBlock must be after fromBlock");
  if (to - from > MAX_SPAN) throw new Error(`span too long: at most ${MAX_SPAN} blocks (about 14 hours)`);
  const [a, b] = await Promise.all([readVault(vault, from), readVault(vault, to)]);
  const share = await reader(to)<Address>(vault, "share");

  // Supply changes, grouped by block and tx
  const byBlock = new Map<bigint, { delta: bigint; txs: Set<Hex> }>();
  for (let start = from + 1n; start <= to; start += LOG_SPAN) {
    const end = start + LOG_SPAN - 1n < to ? start + LOG_SPAN - 1n : to;
    const logs = await client.getLogs({ address: share, event: TRANSFER, fromBlock: start, toBlock: end });
    for (const l of logs) {
      const mint = l.args.from === ZERO, burn = l.args.to === ZERO;
      if (!mint && !burn) continue;
      const row = byBlock.get(l.blockNumber) ?? { delta: 0n, txs: new Set<Hex>() };
      row.delta += mint ? l.args.value! : -l.args.value!;
      row.txs.add(l.transactionHash);
      byBlock.set(l.blockNumber, row);
    }
  }

  const parts: NavPart[] = [];
  const add = (kind: PartKind, unit: NavPart["unit"], delta: bigint, txs: Iterable<Hex>) => {
    if (delta === 0n) return;
    const p = parts.find((x) => x.kind === kind && x.unit === unit);
    if (p) { p.delta += delta; p.txs.push(...txs); } else parts.push({ kind, unit, delta, txs: [...txs] });
  };

  let flowAssets = 0n;
  for (const [blk, row] of [...byBlock].sort((x, y) => (x[0] < y[0] ? -1 : 1))) {
    const [before, after] = await Promise.all([
      reader(blk - 1n)<bigint>(vault, "totalAssets"),
      reader(blk)<bigint>(vault, "totalAssets"),
    ]);
    if (before !== after) {
      flowAssets += after - before;
      add("flows", "usdc", after - before, row.txs);
      add("flows", "shares", row.delta, []);
    } else if (row.delta < 0n) add("admin", "shares", row.delta, row.txs);
    else add("fees", "shares", row.delta, row.txs);
  }

  const mirror = (v: typeof a) => v.adapters.filter((x) => x.kind === "Mirror").reduce((s, x) => s + x.value, 0n);
  const mirrorDelta = mirror(b) - mirror(a);
  add("mirror", "usdc", mirrorDelta, []);
  add("price", "usdc", b.totalAssets - a.totalAssets - flowAssets - mirrorDelta, []);

  return {
    from, to,
    navFrom: a.navPerShare, navTo: b.navPerShare,
    assetsDelta: b.totalAssets - a.totalAssets,
    supplyDelta: b.supply - a.supply,
    parts,
  };
}
