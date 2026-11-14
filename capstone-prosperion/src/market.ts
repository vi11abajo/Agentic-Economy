// Is this address a real Prosper market, and what would a buy get right now?
// A fake market can copy every getter, but it cannot make Prosper's factory list it: the factory maps each R25
// vault to the one market it deployed, so we ask the market for its vault and the factory for that vault's market.
// Anything that reverts along the way just means "not a market"; this never throws on a bad address.
import { getAddress, parseAbi, type Address } from "viem";
import { client } from "./chain.js";
import { PROSPER_FACTORY } from "./protocol.js";

const marketAbi = parseAbi([
  "function r25Vault() view returns (address)",
  "function pToken() view returns (address)",
  "function phase() view returns (uint8)",
  "function realWrappedNativeReserve() view returns (uint256)",
  "function quoteBuy(uint256) view returns (uint256 usedGross, uint256 fee, uint256 netAmountIn, uint256 pTokenOut)",
]);
// deploymentOf(vault) -> (id, pToken, market, buyback, share, cap, scale); all zeros for anything Prosper did not deploy.
const factoryAbi = parseAbi([
  "function deploymentOf(address) view returns (uint256, address, address, address, address, uint256, uint256)",
]);
const beaconAbi = parseAbi(["function implementation() view returns (address)"]);
// keccak256("eip1967.proxy.beacon") - 1
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

export const PHASE_NAME: Record<number, string> = { 0: "on curve", 2: "graduated", 3: "failed" };

export interface MarketCheck {
  market: Address;
  block: bigint;
  genuine: boolean;
  vault: Address | null;
  pToken: Address | null;
  /** 0 on curve, 2 graduated, 3 failed; -1 when it is not a market at all. */
  phase: number;
  /** Real PROS already in the curve. Zero means nobody has bought yet. */
  reserveBefore: bigint;
  /** The market code this proxy runs right now (its beacon's implementation). */
  implNow: Address;
  amountIn: bigint;
  quoteOut: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000" as Address;

export async function checkMarket(market: Address, amountIn: bigint, at?: bigint): Promise<MarketCheck> {
  const block = at ?? (await client.getBlockNumber({ cacheTime: 0 }));
  const out: MarketCheck = {
    market: getAddress(market), block, genuine: false, vault: null, pToken: null,
    phase: -1, reserveBefore: 0n, implNow: ZERO, amountIn, quoteOut: 0n,
  };
  const read = <T>(fn: string, args: readonly unknown[] = []) =>
    client.readContract({ address: market, abi: marketAbi, functionName: fn, args, blockNumber: block } as never) as Promise<T>;
  try {
    const vault = await read<Address>("r25Vault");
    const d = (await client.readContract({
      address: PROSPER_FACTORY, abi: factoryAbi, functionName: "deploymentOf", args: [vault], blockNumber: block,
    })) as readonly unknown[];
    if ((d[2] as string).toLowerCase() !== market.toLowerCase()) return out;
    out.genuine = true;
    out.vault = getAddress(vault);
    out.pToken = getAddress(d[1] as string);
  } catch {
    return out;
  }
  const [phase, reserve, slot] = await Promise.all([
    read<number>("phase"),
    read<bigint>("realWrappedNativeReserve"),
    client.getStorageAt({ address: market, slot: BEACON_SLOT, blockNumber: block }),
  ]);
  out.phase = Number(phase);
  out.reserveBefore = reserve;
  const beacon = getAddress(`0x${(slot ?? "0x").slice(-40)}`);
  out.implNow = await client.readContract({ address: beacon, abi: beaconAbi, functionName: "implementation", blockNumber: block });
  if (out.phase === 0 && amountIn > 0n) {
    const q = await read<readonly bigint[]>("quoteBuy", [amountIn]).catch(() => null);
    out.quoteOut = q ? q[3] : 0n;
  }
  return out;
}
