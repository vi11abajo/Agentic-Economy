// Everything read from Pharos: the Faroswap V3 pools (mid price from slot0, exact swaps through the simulator)
// and the Chainlink feeds. Each read is retried on the public RPC's rate limit.
import {
  createPublicClient,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  http,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { BALANCE_SLOT, CHAIN_ID, FAROSWAP_V3_FACTORY, FEEDS, FEE_TIERS, RPC_URL, SIMULATOR_AT, USDC, WPROS } from "./constants.js";
import { SIMULATOR_CODE } from "./simulator.js";

const RETRY = /too fast|cu limit|429|rate limit|fetch failed|ECONNRESET|socket hang up|header not found|timed out/i;
export async function rpc<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e as { details?: string }).details ?? (e as Error).message);
      if (i >= tries - 1 || !RETRY.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

export function client(): PublicClient {
  return createPublicClient({ transport: http(process.env.PROSARB_RPC || RPC_URL, { retryCount: 0, timeout: 20_000 }) }) as PublicClient;
}

const factoryAbi = parseAbi(["function getPool(address,address,uint24) view returns (address)"]);
const poolAbi = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function token0() view returns (address)",
  "function liquidity() view returns (uint128)",
]);
const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);
const feedAbi = parseAbi(["function latestRoundData() view returns (uint80, int256, uint256, uint256, uint80)"]);
const simAbi = parseAbi(["function exactIn(address pool, bool zeroForOne, uint256 amountIn) returns (uint256 amountOut, uint256 gasUsed)"]);

export interface Pool {
  address: Address;
  fee: number; // 100 = 0.01%
  wprosIsToken0: boolean;
  /** USDC per PROS from slot0, before the pool fee. */
  mid: number;
  wprosReserve: number;
  usdcReserve: number;
}

export async function pools(c: PublicClient): Promise<Pool[]> {
  const chainId = await rpc(() => c.getChainId());
  if (chainId !== CHAIN_ID) throw new Error(`RPC is on chain ${chainId}, expected Pharos mainnet (${CHAIN_ID})`);
  const out: Pool[] = [];
  for (const fee of FEE_TIERS) {
    const address = await rpc(() => c.readContract({ address: FAROSWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [WPROS, USDC, fee] }));
    if (/^0x0{40}$/.test(address)) continue;
    const [slot0, token0, wb, ub] = await Promise.all([
      rpc(() => c.readContract({ address, abi: poolAbi, functionName: "slot0" })),
      rpc(() => c.readContract({ address, abi: poolAbi, functionName: "token0" })),
      rpc(() => c.readContract({ address: WPROS, abi: erc20, functionName: "balanceOf", args: [address] })),
      rpc(() => c.readContract({ address: USDC, abi: erc20, functionName: "balanceOf", args: [address] })),
    ]);
    const wprosIsToken0 = token0.toLowerCase() === WPROS.toLowerCase();
    const raw = (Number(slot0[0]) / 2 ** 96) ** 2; // token1 per token0, in base units
    const mid = wprosIsToken0 ? raw * 10 ** (18 - 6) : 1 / (raw * 10 ** (6 - 18));
    out.push({ address, fee, wprosIsToken0, mid, wprosReserve: Number(formatUnits(wb, 18)), usdcReserve: Number(formatUnits(ub, 6)) });
  }
  return out;
}

const balanceSlot = (holder: Address, slot: number) => keccak256(encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [holder, BigInt(slot)]));

/**
 * Swaps amountIn through the real pool inside an eth_call: the simulator code and its input balance exist only
 * for that call. Returns what the pool pays out and the gas its swap used. Nothing is sent.
 */
export async function simulateSwap(c: PublicClient, pool: Pool, tokenIn: Address, amountIn: bigint): Promise<{ out: bigint; swapGas: bigint }> {
  const zeroForOne = (tokenIn.toLowerCase() === WPROS.toLowerCase()) === pool.wprosIsToken0;
  const data = encodeFunctionData({ abi: simAbi, functionName: "exactIn", args: [pool.address, zeroForOne, amountIn] });
  const override = {
    [SIMULATOR_AT]: { code: SIMULATOR_CODE },
    [tokenIn]: { stateDiff: { [balanceSlot(SIMULATOR_AT, BALANCE_SLOT[tokenIn.toLowerCase()])]: pad(toHex(amountIn), { size: 32 }) } },
  };
  const ret = await rpc(() => c.request({ method: "eth_call", params: [{ to: SIMULATOR_AT, data, gas: "0x1C9C380" }, "latest", override] as never })) as `0x${string}`;
  const [out, swapGas] = decodeFunctionResult({ abi: simAbi, functionName: "exactIn", data: ret });
  return { out, swapGas };
}

export interface Oracles {
  prosUsd: number;
  usdcUsd: number;
  usdtUsd: number;
  ageSec: number; // the oldest of the three
  block: number;
  baseFeeGwei: number;
}

export async function oracles(c: PublicClient): Promise<Oracles> {
  const block = await rpc(() => c.getBlock());
  const read = (a: Address) => rpc(() => c.readContract({ address: a, abi: feedAbi, functionName: "latestRoundData" }));
  const [p, u, t] = await Promise.all([read(FEEDS["PROS/USD"]), read(FEEDS["USDC/USD"]), read(FEEDS["USDT/USD"])]);
  const age = Math.max(...[p, u, t].map((r) => Number(block.timestamp - r[3])));
  const v = (r: readonly [bigint, bigint, bigint, bigint, bigint]) => Number(formatUnits(r[1], 18));
  return { prosUsd: v(p), usdcUsd: v(u), usdtUsd: v(t), ageSec: age, block: Number(block.number), baseFeeGwei: Number(block.baseFeePerGas ?? 10_000_000_000n) / 1e9 };
}
