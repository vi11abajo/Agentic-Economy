// Finding borrowers to watch. Neither protocol keeps a list, but both emit a Borrow event with the borrower as the
// second indexed topic, so one OR-topic log query over the venues' addresses finds them all.
import { keccak256, toHex, type Hex } from "viem";
import type { Chain } from "./chain.js";
import { AAVE_POOLS, MORPHO } from "./venues.js";

export const BORROW_TOPICS = [
  keccak256(toHex("Borrow(address,address,address,uint256,uint8,uint256,uint16)")), // Aave V3
  keccak256(toHex("Borrow(bytes32,address,address,address,uint256,uint256)")), // Morpho Blue
];

export interface Borrower {
  wallet: Hex;
  venue: Hex;
  lastBlock: number;
  /** Morpho market id when the borrow came from Morpho. */
  market?: Hex;
}

export async function recentBorrowers(chain: Chain, head: number, blocks: number, onProgress?: (done: number, total: number) => void): Promise<Borrower[]> {
  const from = Math.max(1, head - blocks);
  const seen = new Map<string, Borrower>();
  const addresses = [MORPHO, ...AAVE_POOLS.map((p) => p.pool)];
  const total = Math.ceil((head - from + 1) / 999);
  let done = 0;
  for (let a = from; a <= head; a += 999) {
    const logs = await chain.logs({ from: a, to: Math.min(head, a + 998), address: addresses, topics: [BORROW_TOPICS] });
    for (const l of logs) {
      const wallet = `0x${l.topics[2].slice(26)}` as Hex;
      const isMorpho = l.address.toLowerCase() === MORPHO.toLowerCase();
      const key = `${l.address.toLowerCase()}:${isMorpho ? l.topics[1] : ""}:${wallet.toLowerCase()}`;
      seen.set(key, { wallet, venue: l.address, lastBlock: l.blockNumber, market: isMorpho ? l.topics[1] : undefined });
    }
    onProgress?.(++done, total);
  }
  return [...seen.values()];
}
