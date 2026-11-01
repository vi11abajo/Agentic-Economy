// What the two sellers sell. Both are live reads of Pharos mainnet:
//   Harbor data: the 16 Pharos Harbor assets (yield, open or not, exit) and one wallet's positions, through
//   harborpilot's adapters (11-harborpilot).
//   PROS market: PROS on Faroswap V3 (every WPROS/USDC pool: mid price, reserves) and the Chainlink PROS/USD feed.
import { formatEther, formatUnits, getAddress, parseAbi, parseUnits, type Address, type PublicClient } from "viem";
import { position, type Ctx, type Quote } from "harborpilot/dist/adapters.js";
import { blocksAgo, pinnedBlock, withTimeout } from "harborpilot/dist/chain.js";
import { PROBE, quoteAll } from "harborpilot/dist/cli.js";
import { loanOf, marketState } from "harborpilot/dist/morpho.js";
import { route } from "harborpilot/dist/router.js";
import { VENUES } from "harborpilot/dist/venues.js";
import { USDC } from "../pharos.js";

const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";
const FAROSWAP_V3_FACTORY: Address = "0x2c90CcB0b989afA2433F499698451a25744A552b";
const PROS_USD_FEED: Address = "0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466";
const VENUE_TIMEOUT_MS = 25_000;

const round = (x: number | undefined, d = 4) => (x === undefined || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

async function context(client: PublicClient): Promise<Ctx> {
  const now = await pinnedBlock(client);
  return { client, ...now, past: await blocksAgo(client, now, [7, 30]) };
}

/** A short-lived cache, so a burst of buyers doesn't turn into a burst of archive reads on the public RPC. */
function cached<T>(ttlMs: number, load: (key: string) => Promise<T>) {
  const m = new Map<string, { at: number; value: Promise<T> }>();
  return (key: string) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = load(key);
    m.set(key, { at: Date.now(), value });
    value.catch(() => m.delete(key));
    return value;
  };
}

function venueRow(q: Quote) {
  return {
    id: q.venue.id,
    name: q.venue.name,
    protocol: q.venue.protocol,
    status: q.status,
    reason: q.reason ?? null,
    tvl_usdc: round(q.tvl, 2),
    apy_7d_pct: round(q.apy.d7, 2),
    apy_30d_pct: round(q.apy.d30, 2),
    min_deposit_usdc: round(q.minDeposit, 2),
    exit_days: round(q.exitDays, 2),
    exit_how: q.exitHow || null,
    exit_fee_pct: round(q.exitFeePct, 3),
    harbor_terms: { liquidity: q.venue.harbor.liquidity, access: q.venue.harbor.access, regions: q.venue.harbor.regions },
    notes: q.notes,
  };
}

export function harborData(client: PublicClient) {
  const yields = cached(60_000, async (amountText: string) => {
    const ctx = await context(client);
    const qs = await quoteAll(ctx, PROBE, parseUnits(amountText, 6), { venue_timeout_ms: VENUE_TIMEOUT_MS });
    const r = route(qs, { amount: Number(amountText), allowAsyncDeposit: true, stableOnly: false, horizonDays: 90 });
    return {
      block: ctx.block.toString(),
      deposit_checked_usdc: Number(amountText),
      note: "status 'open' = this deposit passes in simulation right now; apy = realized share-price growth, not a target",
      best: r.ranked[0] ? { id: r.ranked[0].quote.venue.id, ranked_apy_pct: round(r.ranked[0].apy, 2), net_apy_pct: round(r.ranked[0].net, 2), why: r.explanation } : null,
      venues: qs.map(venueRow),
    };
  });

  return {
    async yields(amount: string | undefined) {
      const a = amount && /^\d+(\.\d{1,6})?$/.test(amount) && Number(amount) > 0 ? amount : "100";
      return yields(a);
    },

    async positions(address: string) {
      const user = getAddress(address);
      const ctx = await context(client);
      const res = await Promise.allSettled(VENUES.map((v) => withTimeout(position(ctx, v, user), VENUE_TIMEOUT_MS, v.name)));
      const held = res.flatMap((r, i): Record<string, unknown>[] => {
        if (r.status === "rejected") return [{ id: VENUES[i].id, down: String((r.reason as Error)?.message ?? r.reason).split("\n")[0] }];
        const p = r.value;
        if (!p.shares && !p.pendingDeposit && !p.claimableDeposit && !p.pendingRedeem && !p.claimableRedeem) return [];
        return [{
          id: p.venue.id,
          name: p.venue.name,
          shares: formatUnits(p.shares, p.shareDecimals),
          value: round(p.assets, 6),
          pending_deposit_usdc: round(p.pendingDeposit, 6),
          claimable_deposit_usdc: round(p.claimableDeposit, 6),
          pending_redeem_shares: round(p.pendingRedeem, 6),
          claimable_redeem_shares: round(p.claimableRedeem, 6),
        }];
      });
      const m = await marketState(ctx);
      const loan = await loanOf(ctx, m, user);
      return {
        block: ctx.block.toString(),
        address: user,
        harbor: held,
        morpho_loan:
          loan.collateral || loan.borrowShares
            ? { collateral_wpros: formatEther(loan.collateral), debt_usdc: formatUnits(loan.debt, 6), ltv_pct: round(loan.ltv * 100, 2), liquidation_price_usdc: round(loan.liquidationPrice, 4) }
            : null,
        note: "numbered ERC-7540 requests filed by other apps are not listed (their ids are not known here)",
      };
    },
  };
}

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)", "function decimals() view returns (uint8)"]);

export function prosData(client: PublicClient) {
  const price = cached(15_000, async () => {
    const block = await client.getBlock();
    const pools = [];
    for (const fee of [100, 500, 3000, 10000]) {
      const address = await client.readContract({ address: FAROSWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [WPROS, USDC, fee], blockNumber: block.number });
      if (/^0x0{40}$/.test(address)) continue;
      const [slot0, token0, wb, ub] = await Promise.all([
        client.readContract({ address, abi: poolAbi, functionName: "slot0", blockNumber: block.number }),
        client.readContract({ address, abi: poolAbi, functionName: "token0", blockNumber: block.number }),
        client.readContract({ address: WPROS, abi: erc20, functionName: "balanceOf", args: [address], blockNumber: block.number }),
        client.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address], blockNumber: block.number }),
      ]);
      const raw = (Number(slot0[0]) / 2 ** 96) ** 2; // token1 per token0, in base units
      const mid = token0.toLowerCase() === WPROS.toLowerCase() ? raw * 1e12 : 1 / (raw / 1e12);
      pools.push({ pool: address, fee_pct: fee / 10_000, mid_usdc_per_pros: round(mid, 6), wpros_reserve: round(Number(formatEther(wb)), 2), usdc_reserve: round(Number(formatUnits(ub, 6)), 2) });
    }
    const [round_, dec] = await Promise.all([
      client.readContract({ address: PROS_USD_FEED, abi: feedAbi, functionName: "latestRoundData", blockNumber: block.number }),
      client.readContract({ address: PROS_USD_FEED, abi: feedAbi, functionName: "decimals", blockNumber: block.number }),
    ]);
    const deepest = [...pools].sort((a, b) => (b.usdc_reserve ?? 0) - (a.usdc_reserve ?? 0))[0];
    return {
      block: block.number.toString(),
      faroswap_v3_pools: pools,
      deepest_pool_mid_usdc_per_pros: deepest?.mid_usdc_per_pros ?? null,
      chainlink_pros_usd: round(Number(formatUnits(round_[1], dec)), 6),
      chainlink_age_sec: Number(block.timestamp - round_[3]),
    };
  });
  return { price: () => price("") };
}
