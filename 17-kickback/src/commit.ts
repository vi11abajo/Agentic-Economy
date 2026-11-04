// The commit is the whole point: the list of people and the rule, written on chain in a self transaction
// before the block whose hash picks the winners exists. Everything verify needs is inside this one tx.
import { concat, decodeAbiParameters, encodeAbiParameters, stringToHex, type Address, type Hex } from "viem";

export type Commit = { snapshot: bigint; delay: number; winners: number; token: Address; amountRaw: bigint; pool: Address[] };

export const PROS_TOKEN = "0x0000000000000000000000000000000000000000" as Address;
const PREFIX = stringToHex("kickback:1:");
const LAYOUT = [
  { name: "snapshot", type: "uint64" },
  { name: "delay", type: "uint16" },
  { name: "winners", type: "uint16" },
  { name: "token", type: "address" },
  { name: "amountRaw", type: "uint256" },
  { name: "pool", type: "address[]" },
] as const;

export function encodeCommit(c: Commit): Hex {
  return concat([PREFIX, encodeAbiParameters(LAYOUT, [c.snapshot, c.delay, c.winners, c.token, c.amountRaw, c.pool])]);
}

export function decodeCommit(data: Hex): Commit {
  const lower = data.toLowerCase();
  if (!lower.startsWith(PREFIX)) throw new Error("not a kickback commit (the data doesn't start with kickback:1:)");
  const [snapshot, delay, winners, token, amountRaw, pool] = decodeAbiParameters(LAYOUT, `0x${lower.slice(PREFIX.length)}`);
  return {
    snapshot,
    delay,
    winners,
    token: token.toLowerCase() as Address,
    amountRaw,
    pool: pool.map((a) => a.toLowerCase() as Address),
  };
}
