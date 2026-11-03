// "The latest real wallets": walk back from the newest block, take each transaction sender once, and keep only
// addresses with no code at all. A contract can't be a person, and a wallet delegated through EIP-7702 has
// handed its code to someone else's contract, so it's left out too.
import { getAddress, type Address } from "viem";
import type { Chain } from "./chain.js";

export async function recentWallets(chain: Chain, count: number, opts: { exclude: Address[]; maxBlocks?: number }): Promise<Array<{ address: Address; block: bigint }>> {
  const skip = new Set(opts.exclude.map((a) => a.toLowerCase()));
  const found: Array<{ address: Address; block: bigint }> = [];
  const top = await chain.blockNumber();
  const floor = top - BigInt(opts.maxBlocks ?? 500);
  for (let n = top; n > floor && found.length < count; n--) {
    const { senders } = await chain.block(n);
    for (const sender of senders) {
      const key = sender.toLowerCase();
      if (skip.has(key)) continue;
      skip.add(key);
      if ((await chain.code(sender)) !== "0x") continue;
      found.push({ address: getAddress(sender), block: n });
      if (found.length === count) break;
    }
  }
  return found;
}
