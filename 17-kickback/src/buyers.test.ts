import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeAbiParameters, pad, type Address, type Hex } from "viem";
import { tapeChain, type Chain, type LogQuery, type RpcLog } from "./chain.js";
import { SWAP_TOPIC, buyFromLog, collectPool, type Pair } from "./buyers.js";

const WPROS = "0x52c48d4213107b20bc583832b0d951fb9ca8f0b0" as Address;
const PCARR = "0xd6d6c5b012a81d793dead821d1dd05446e1118c5" as Address;
const PAIR_A = "0x3fa4fbe561f6d5996ca69b4fb82e61a01d3ae558" as Address; // WPROS is token0
const PAIR_B = "0xaf2b77d76c6256826c2b650aa6d0bbf297a0e7b8" as Address; // WPROS is token1
const ROUTER = "0x14f06fe99a1264825c99fb1c8e05a90036e89d0a" as Address;
const ME = "0x46441dc99f8000959e9c48cf2a01a018d131d3bb" as Address;
const pairs: Pair[] = [
  { pair: PAIR_A, wprosIs0: true, token: PCARR },
  { pair: PAIR_B, wprosIs0: false, token: "0x52acdeb49056518578c7af788ae2c367132e2db5" },
];

const who = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;

function swap(pair: Address, to: Address, block: bigint, amounts: [bigint, bigint, bigint, bigint], logIndex = 0): RpcLog {
  return {
    address: pair,
    topics: [SWAP_TOPIC, pad(ROUTER), pad(to)],
    data: encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], amounts),
    blockNumber: block,
    logIndex,
    transactionHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
  };
}

test("buyFromLog sees a buy when WPROS goes in, whichever side WPROS is on", () => {
  const a = buyFromLog(swap(PAIR_A, who(1), 10n, [5n, 0n, 0n, 7n]), pairs);
  assert.deepEqual(a, { buyer: who(1), pair: PAIR_A, block: 10n });
  const b = buyFromLog(swap(PAIR_B, who(2), 11n, [0n, 5n, 7n, 0n]), pairs);
  assert.equal(b?.buyer, who(2));
});

test("buyFromLog ignores sells and unknown pairs", () => {
  assert.equal(buyFromLog(swap(PAIR_A, who(1), 10n, [0n, 7n, 5n, 0n]), pairs), null);
  assert.equal(buyFromLog(swap(who(99), who(1), 10n, [5n, 0n, 0n, 7n]), pairs), null);
});

// A pretend chain that only knows logs and code: enough for collectPool.
function logChain(logs: RpcLog[], contracts: Address[] = []): Chain {
  return {
    journal: [],
    step() {},
    async logs(q: LogQuery) {
      return logs.filter((l) => l.blockNumber >= q.from && l.blockNumber <= q.to);
    },
    async code(a: Address) {
      return contracts.includes(a) ? "0x6080" : "0x";
    },
  } as unknown as Chain;
}

test("collectPool goes newest first, dedupes, and stops at the size", async () => {
  const logs = [
    swap(PAIR_A, who(1), 1000n, [5n, 0n, 0n, 7n]),
    swap(PAIR_A, who(2), 2500n, [5n, 0n, 0n, 7n]),
    swap(PAIR_B, who(1), 2600n, [0n, 5n, 7n, 0n]),
    swap(PAIR_A, who(3), 2600n, [5n, 0n, 0n, 7n], 1),
  ];
  const pool = await collectPool(logChain(logs), pairs, { snapshot: 3000n, size: 2, lookback: 50000, exclude: [] });
  assert.deepEqual(pool.people, [who(3), who(1)]);
  assert.equal(pool.complete, true);
});

test("collectPool skips our own wallet and contracts", async () => {
  const logs = [
    swap(PAIR_A, ME, 900n, [5n, 0n, 0n, 7n]),
    swap(PAIR_A, who(7), 800n, [5n, 0n, 0n, 7n]),
    swap(PAIR_A, who(8), 700n, [5n, 0n, 0n, 7n]),
  ];
  const pool = await collectPool(logChain(logs, [who(7)]), pairs, { snapshot: 1000n, size: 5, lookback: 1000, exclude: [ME] });
  assert.deepEqual(pool.people, [who(8)]);
  assert.equal(pool.skippedContracts, 1);
});

test("collectPool stops at the look-back cap", async () => {
  const logs = [swap(PAIR_A, who(1), 9000n, [5n, 0n, 0n, 7n]), swap(PAIR_A, who(2), 8500n, [5n, 0n, 0n, 7n]), swap(PAIR_A, who(3), 5000n, [5n, 0n, 0n, 7n])];
  const pool = await collectPool(logChain(logs), pairs, { snapshot: 10000n, size: 30, lookback: 3000, exclude: [] });
  assert.deepEqual(pool.people, [who(1), who(2)]);
  assert.equal(pool.complete, false);
  assert.equal(pool.scannedFrom, 7001n);
});

test("on the recorded mainnet tape: 30 wallets, newest first, no duplicates", async () => {
  const file = JSON.parse(readFileSync(join(process.cwd(), "test", "tapes", "buyers.json"), "utf8"));
  const chain = tapeChain(file.tape);
  const { findPairs } = await import("./buyers.js");
  const found = await findPairs(chain, BigInt(file.snapshot));
  assert.equal(found.length, 10);
  const pool = await collectPool(chain, found, { snapshot: BigInt(file.snapshot), size: 30, lookback: 50000, exclude: [ME] });
  assert.equal(pool.people.length, 30);
  assert.equal(new Set(pool.people).size, 30);
  assert.equal(pool.complete, true);
});
