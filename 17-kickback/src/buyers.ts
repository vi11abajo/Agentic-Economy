// Who bought Prosper tokens lately. Prosper's graduated tokens trade on its own UniswapV2-style pairs, all of
// them WPROS against a p-token, so "a buyer" here is whoever got p-tokens out of a swap that put WPROS in.
import { decodeAbiParameters, type Address, type Hex } from "viem";
import type { Chain, RpcLog } from "./chain.js";

export const PROSPER_V2_FACTORY = "0x9343d6f1a7058a9ffd43028666db23cfce3e0d1e" as Address;
export const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0" as Address;
export const SWAP_TOPIC = "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822" as Hex;

export type Pair = { pair: Address; wprosIs0: boolean; token: Address };
export type Pool = { snapshot: bigint; people: Address[]; scannedFrom: bigint; skippedContracts: number; complete: boolean };

const WINDOW = 1000n; // the MCP refuses get_logs over more than 1000 blocks

const asAddress = (word: Hex) => `0x${word.slice(-40)}`.toLowerCase() as Address;
const word = (n: bigint) => n.toString(16).padStart(64, "0");

/** Every pair the Prosper V2 factory knows about at `block`, with which side is WPROS. */
export async function findPairs(chain: Chain, block: bigint): Promise<Pair[]> {
  const count = BigInt(await chain.call(PROSPER_V2_FACTORY, "0x574f2ba3", block)); // allPairsLength()
  const found: Pair[] = [];
  for (let i = 0n; i < count; i++) {
    const pair = asAddress(await chain.call(PROSPER_V2_FACTORY, `0x1e3dd18b${word(i)}`, block)); // allPairs(i)
    const token0 = asAddress(await chain.call(pair, "0x0dfe1681", block));
    const token1 = asAddress(await chain.call(pair, "0xd21220a7", block));
    // Anything not paired with WPROS isn't a "buy with PROS"; skip it rather than guess.
    if (token0 === WPROS) found.push({ pair, wprosIs0: true, token: token1 });
    else if (token1 === WPROS) found.push({ pair, wprosIs0: false, token: token0 });
  }
  return found;
}

/** A Swap log that put WPROS in is a buy; `to` (topic 2) is the wallet that walked away with the p-tokens. */
export function buyFromLog(log: RpcLog, pairs: Pair[]): { buyer: Address; pair: Address; block: bigint } | null {
  const p = pairs.find((x) => x.pair === log.address.toLowerCase());
  if (!p || log.topics[0] !== SWAP_TOPIC || log.topics.length < 3) return null;
  const [in0, in1] = decodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], log.data);
  const wprosIn = p.wprosIs0 ? in0 : in1;
  if (wprosIn === 0n) return null;
  return { buyer: asAddress(log.topics[2]), pair: p.pair, block: log.blockNumber };
}

/**
 * Walks back from `snapshot` one 1000-block window at a time, newest buy first, until it has `size` different
 * people. A buyer with contract code (a router, a bot contract, a vault) isn't a person and gets skipped; so does
 * anyone in `exclude` (our own wallet). Gives up at `lookback` blocks and says so with complete = false.
 */
export async function collectPool(
  chain: Chain,
  pairs: Pair[],
  opts: { snapshot: bigint; size: number; lookback: number; exclude: Address[] },
): Promise<Pool> {
  const people: Address[] = [];
  const judged = new Map<Address, boolean>(); // address -> is a person
  const exclude = new Set(opts.exclude.map((a) => a.toLowerCase() as Address));
  const floor = opts.snapshot - BigInt(opts.lookback) + 1n;
  let skippedContracts = 0;
  let to = opts.snapshot;
  let scannedFrom = opts.snapshot + 1n;

  while (people.length < opts.size && to >= floor) {
    const from = to - WINDOW + 1n > floor ? to - WINDOW + 1n : floor;
    const logs = await chain.logs({ address: pairs.map((p) => p.pair), topics: [SWAP_TOPIC], from, to });
    scannedFrom = from;
    logs.sort((a, b) => (a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1));
    for (const log of logs) {
      const buy = buyFromLog(log, pairs);
      if (!buy || exclude.has(buy.buyer) || judged.has(buy.buyer)) continue;
      const human = (await chain.code(buy.buyer)) === "0x";
      judged.set(buy.buyer, human);
      if (!human) {
        skippedContracts++;
        continue;
      }
      people.push(buy.buyer);
      if (people.length === opts.size) break;
    }
    to = from - 1n;
  }
  return { snapshot: opts.snapshot, people, scannedFrom, skippedContracts, complete: people.length === opts.size };
}
