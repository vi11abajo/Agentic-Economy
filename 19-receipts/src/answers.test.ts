import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pad, toHex } from "viem";
import { fakeChain } from "./fakechain.js";
import { runScan } from "./scan.js";
import { biggest, holdings, render, where, total, pnl } from "./answers.js";
import { checkAnswer } from "./check.js";
import { PROS_USD_FEED, PROSPER_V2_FACTORY, USDC } from "./prices.js";
import { WPROS } from "./chain.js";
import type { Fetcher } from "./explorer.js";

process.env.RECEIPTS_HOME = mkdtempSync(join(tmpdir(), "receipts-answers-"));

const W = "0x00000000000000000000000000000000000000aa";
const TOK = "0x0000000000000000000000000000000000000001";
const PAIR = "0x0000000000000000000000000000000000000002";
const VAULT = "0x0000000000000000000000000000000000000003";
const E18 = 10n ** 18n;

const rows: Record<string, unknown[]> = {
  transactions: [],
  token_transfers: [
    { transaction_hash: "0x01", log_index: 0, from_address: "0x99", to_address: W, value: "1000", token_address: TOK, block_number: 5, token_info: { symbol: "TOK", decimals: 18 } },
    { transaction_hash: "0x02", log_index: 0, from_address: "0x99", to_address: W, value: "3", token_address: USDC, block_number: 6, token_info: { symbol: "USDC", decimals: 6 } },
    { transaction_hash: "0x03", log_index: 0, from_address: "0x0000000000000000000000000000000000000000", to_address: W, value: "10", token_address: VAULT, block_number: 7, token_info: { symbol: "vUSDC", decimals: 6 } },
  ],
  internal_transactions: [],
};
const fetcher: Fetcher = async (url) => {
  const kind = new URL(url).pathname.split("/").pop()!;
  return { total: rows[kind].length, data: new URL(url).searchParams.get("page") === "1" ? rows[kind] : [] };
};

const line = fakeChain({
  [PROS_USD_FEED]: { decimals: () => 18, latestRoundData: () => [1n, 5n * 10n ** 17n, 0n, 1_762_366_510n, 1n] },
  [PROSPER_V2_FACTORY]: { allPairsLength: () => 1n, allPairs: () => PAIR },
  [PAIR]: { token0: () => TOK, token1: () => WPROS, getReserves: () => [1000n * E18, 4n * E18, 0] }, // TOK = 0.004 PROS = 0.002 USD
  [TOK]: { symbol: () => "TOK", decimals: () => 18, balanceOf: () => 1000n * E18 },
  [USDC]: { symbol: () => "USDC", decimals: () => 6, balanceOf: () => 3_000_000n },
  [VAULT]: { symbol: () => "vUSDC", decimals: () => 6, name: () => "Steady USDC", balanceOf: () => 10_000_000n, asset: () => USDC, convertToAssets: (x: bigint) => (x * 21n) / 20n },
} as never, {
  get_balance: JSON.stringify({ balanceWei: (2n * E18).toString() }),
  get_transaction: JSON.stringify({ from: "0x0000000000000000000000000000000000000099", to: TOK, value: "0x0" }),
  get_transaction_receipt: JSON.stringify({ blockNumber: "0x5", status: "0x1", logs: [{ address: TOK, topics: ["0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", pad("0x0000000000000000000000000000000000000099"), pad(W)], data: toHex(1000n * E18, { size: 32 }), logIndex: "0x0" }] }),
});

const scanned = runScan(line, W, fetcher);

test("holdings list every position with a USD value and a total, each with fact ids", async () => {
  const scan = await scanned;
  const a = holdings(scan);
  const text = a.lines.join("\n");
  assert.match(text, /1000 TOK in the wallet: worth \$2 \[F\d+/);
  assert.match(text, /10 vUSDC in Steady USDC \(vault\), which is 10\.5 USDC: worth \$10\.5/);
  assert.match(text, /Total: \$16\.5 \[F\d+\]/); // 1 PROS-worth (2 x 0.5) + 2 + 3 + 10.5
  assert.ok(checkAnswer(text, scan.ledger.facts()).ok, checkAnswer(text, scan.ledger.facts()).problems.join("; "));
});

test("where finds USDC both in the wallet and inside the vault", async () => {
  const scan = await scanned;
  const a = where(scan, "USDC");
  assert.equal(a.lines.length, 2);
  assert.ok(a.lines.some((l) => l.includes("in the wallet")) && a.lines.some((l) => l.includes("Steady USDC")));
});

test("biggest puts the vault first", async () => {
  const scan = await scanned;
  assert.match(biggest(scan).lines[0], /^1\. 10 vUSDC/);
});

test("the rendered answer lists every cited fact with its contract and block, and the reasons for unknowns", async () => {
  const scan = await scanned;
  const out = render(scan, total(scan));
  assert.match(out, /Sources:\n[\s\S]*  F\d+  total worth in USD: 16\.5 USD \| sum of/);
  const p = await pnl(scan, "TOK");
  const text = render(scan, p);
  assert.match(text, /What receipts can't tell you, and why:\n  - TOK: this wallet received it by transfer and never paid for it\./);
});

test("an answer with a made-up number fails the check", async () => {
  const scan = await scanned;
  const id = scan.saved.valuation.totalFact!;
  assert.equal(checkAnswer(`You have about $16.5 in total [${id}]`, scan.ledger.facts()).ok, true);
  assert.equal(checkAnswer(`You have about $20 in total [${id}]`, scan.ledger.facts()).ok, false);
});

test("read-only by construction: no signer, no key, no send anywhere in the source", () => {
  const dir = new URL("../src/", import.meta.url);
  const offenders: string[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
    const src = readFileSync(new URL(file, dir), "utf8");
    for (const word of ["privateKey", "signTransaction", "sendTransaction", "walletClient", "privateKeyToAccount", "writeContract"]) {
      if (src.includes(word)) offenders.push(`${file}: ${word}`);
    }
    // send_raw_transaction may appear only in the comment explaining the allowlist in mcp.ts
    if (file !== "mcp.ts" && src.includes("send_raw_transaction")) offenders.push(`${file}: send_raw_transaction`);
  }
  assert.deepEqual(offenders, []);
});
