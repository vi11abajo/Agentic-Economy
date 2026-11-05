import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadIndex, indexGaps, type Fetcher } from "./explorer.js";
import { ScriptedLine } from "./fakes.js";
import { NotAllowed } from "./mcp.js";

process.env.RECEIPTS_HOME = mkdtempSync(join(tmpdir(), "receipts-test-"));

const WALLET = "0x9f857e7894e34d1cd09e55a8a27a8742729ea37c";

/** A pretend explorer: `rows[kind]` is the newest-first list, served in pages like the real one. */
function fakeExplorer(rows: Record<string, unknown[]>, totals: Record<string, number> = {}) {
  const asked: string[] = [];
  const fetcher: Fetcher = async (url: string) => {
    asked.push(url);
    const u = new URL(url);
    const kind = u.pathname.split("/").pop()!;
    const page = Number(u.searchParams.get("page"));
    const size = Number(u.searchParams.get("size"));
    const all = rows[kind] ?? [];
    return { total: totals[kind] ?? all.length, data: all.slice((page - 1) * size, page * size) };
  };
  return { fetcher, asked };
}

const tx = (i: number) => ({ hash: `0x${i.toString(16).padStart(64, "0")}`, from_address: WALLET, to_address: "0xabc", value: "0", method_id: "0x", block_number: 1000 + i, receipt_status: 1 });

test("pages until it has everything the explorer says exists", async () => {
  const txs = Array.from({ length: 251 }, (_, i) => tx(251 - i));
  const { fetcher, asked } = fakeExplorer({ transactions: txs });
  const ix = await loadIndex(WALLET, fetcher);
  assert.equal(ix.txs.length, 251);
  const txPages = asked.filter((u) => u.includes("/transactions"));
  assert.deepEqual(txPages.map((u) => new URL(u).searchParams.get("page")), ["1", "2", "3"]);
  assert.ok(txPages.every((u) => new URL(u).searchParams.get("size") === "100"));
});

test("a second look only fetches what is new since last time", async () => {
  const older = Array.from({ length: 251 }, (_, i) => tx(251 - i));
  await loadIndex(WALLET, fakeExplorer({ transactions: older }).fetcher);
  const newer = [tx(253), tx(252), ...older];
  const { fetcher, asked } = fakeExplorer({ transactions: newer });
  const ix = await loadIndex(WALLET, fetcher);
  assert.equal(ix.txs.length, 253);
  assert.equal(asked.filter((u) => u.includes("/transactions")).length, 1);
});

test("a short history is called out, not hidden", async () => {
  const transfers = Array.from({ length: 279 }, (_, i) => ({ transaction_hash: `0x${i}`, log_index: 0, from_address: "0x1", to_address: WALLET, value: "1", token_address: "0xt", block_number: i, token_info: { symbol: "T", decimals: 18 } }));
  const { fetcher } = fakeExplorer({ token_transfers: transfers }, { token_transfers: 281 });
  const ix = await loadIndex("0x00000000000000000000000000000000000000aa", fetcher);
  assert.deepEqual(indexGaps(ix), ["token transfers: got 279 of 281"]);
});

test("send_raw_transaction is refused before it leaves the machine", async () => {
  const line = new ScriptedLine({ send_raw_transaction: "0xdead" });
  await assert.rejects(line.ask("send_raw_transaction", { raw: "0x00" }), NotAllowed);
  assert.equal(line.asked.length, 0);
});
