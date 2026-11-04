// The draw itself, small on purpose so anyone can redo it by hand: mix the target block's hash with the commit
// tx hash, then take winners one by one out of the committed list.
import { encodePacked, keccak256, type Address, type Hex } from "viem";

export function seedOf(targetHash: Hex, commitTx: Hex): Hex {
  return keccak256(encodePacked(["bytes32", "bytes32"], [targetHash, commitTx]));
}

/** Winner i = keccak256(seed, i) mod (people still in the hat); a winner leaves the hat, so nobody wins twice. */
export function pickWinners(seed: Hex, pool: Address[], k: number): Address[] {
  const hat = [...pool];
  const winners: Address[] = [];
  for (let i = 0; i < k && hat.length > 0; i++) {
    const roll = BigInt(keccak256(encodePacked(["bytes32", "uint256"], [seed, BigInt(i)])));
    winners.push(hat.splice(Number(roll % BigInt(hat.length)), 1)[0]);
  }
  return winners;
}
