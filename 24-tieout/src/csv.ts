// Spreadsheet export: one row per movement of money, so a SUM over a column gives the totals in the report. Gas is
// put only on a transaction's first row, otherwise summing it would count one fee several times.
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { EXPLORER_TX } from "./chain.js";
import { NATIVE } from "./ledger.js";
import { formatAmount, nameOf, type Report } from "./report.js";
import { describe } from "./words.js";

const cell = (v: string | number | bigint) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const row = (cells: (string | number | bigint)[]) => cells.map(cell).join(",");
const plain = (v: bigint, decimals: number) => formatAmount(v, decimals).replace(/,/g, "");
const iso = (t: number) => new Date(t * 1000).toISOString().replace(".000Z", "Z");

export function transactionsCsv(r: Report): string {
  const lines = [
    row(["time_utc", "block", "tx_hash", "category", "sent_by_wallet", "status", "direction", "asset", "token_address", "amount", "counterparty", "counterparty_name", "gas_fee_pros", "description", "link"]),
  ];
  for (const e of r.entries) {
    const base = [iso(e.time), e.block, e.hash, e.category, e.mine ? "yes" : "no", e.ok ? "ok" : "failed"];
    const what = describe(r, e);
    const gas = (first: boolean) => (first && e.mine ? plain(e.fee, 18) : "");
    if (!e.flows.length) {
      lines.push(row([...base, "", "", "", "", e.target ? getAddress(e.target) : "", e.target ? nameOf(r, e.target) : "", gas(true), what, EXPLORER_TX + e.hash]));
      continue;
    }
    e.flows.forEach((f, i) => {
      const info = r.assets.get(f.asset);
      lines.push(
        row([
          ...base,
          f.dir,
          info?.label ?? f.asset,
          f.asset === NATIVE ? "" : getAddress(f.asset),
          plain(f.amount, info?.decimals ?? 18),
          getAddress(f.counterparty),
          nameOf(r, f.counterparty),
          gas(i === 0),
          what,
          EXPLORER_TX + e.hash,
        ]),
      );
    });
  }
  return lines.join("\n") + "\n";
}

export function booksCsv(r: Report): string {
  // the two blocks go into every row, so this file alone is enough to re-check the balances on chain
  const lines = [row(["asset", "token_address", "opening_block", "opening", "in", "out", "gas", "expected_closing", "closing_block", "closing_on_chain", "gap", "ties"])];
  for (const l of r.books) {
    const d = r.assets.get(l.asset)?.decimals ?? 18;
    lines.push(
      row([
        r.assets.get(l.asset)?.label ?? l.asset,
        l.asset === NATIVE ? "" : getAddress(l.asset),
        r.openBlock,
        plain(l.opening, d),
        plain(l.in, d),
        plain(l.out, d),
        plain(l.fees, d),
        plain(l.expected, d),
        r.closeBlock,
        plain(l.closing, d),
        l.gap === null ? "unknown" : plain(l.gap, d),
        l.gap === 0n ? "yes" : "no",
      ]),
    );
  }
  return lines.join("\n") + "\n";
}

/** Same wallet, same period, same chain -> same fingerprint. Lets someone check a rerun against a filed report. */
export function fingerprint(r: Report): string {
  return createHash("sha256").update(transactionsCsv(r)).update(booksCsv(r)).digest("hex").slice(0, 16);
}
