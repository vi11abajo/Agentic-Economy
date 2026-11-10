// The plain-language layer shared by all three exports, so the Markdown, the CSV and the PDF say the same thing in
// the same words.
import { CATEGORY_ONE, CATEGORY_TITLE, NATIVE, type Entry, type Flow } from "./ledger.js";
import { localTime } from "./period.js";
import { UNLIMITED, formatAmount, nameOf, type Report } from "./report.js";
import { ties } from "./tieout.js";

export const amountOf = (r: Report, asset: string, v: bigint) => `${formatAmount(v, r.assets.get(asset)?.decimals ?? 18)} ${r.assets.get(asset)?.label ?? asset}`;

const list = (parts: string[]) => (parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`);

// Several transfers of one asset in one tx (a batch payout, say) read better as one sum per asset.
function summed(r: Report, flows: Flow[]): string {
  const by = new Map<string, bigint>();
  for (const f of flows) by.set(f.asset, (by.get(f.asset) ?? 0n) + f.amount);
  return list([...by].map(([a, v]) => amountOf(r, a, v)));
}

const people = (r: Report, flows: Flow[]) => list([...new Set(flows.map((f) => nameOf(r, f.counterparty)))]);

/** One sentence per transaction: what happened, in words a non-developer follows. */
export function describe(r: Report, e: Entry): string {
  const outs = e.flows.filter((f) => f.dir === "out");
  const ins = e.flows.filter((f) => f.dir === "in");
  const target = e.target ? nameOf(r, e.target) : "a new contract";
  // the explorer decodes most method names; when it couldn't, the 4-byte id is all there is
  const raw = /^0x[0-9a-f]*$/i.test(e.method);
  const call = e.method && !raw ? `${e.method} on ${target}` : `a call to ${target}${e.method.length === 10 ? ` (method ${e.method})` : ""}`;
  switch (e.category) {
    case "transfer_out":
      return `sent ${summed(r, outs)} to ${people(r, outs)}${e.mine ? "" : ` (the transaction was sent by ${nameOf(r, e.sender)})`}`;
    case "transfer_in":
      return `received ${summed(r, ins)} from ${people(r, ins)}`;
    case "swap":
      return `swapped ${summed(r, outs)} for ${summed(r, ins)} via ${target}`;
    case "approval":
      return list(
        e.approvals.map((a) => {
          const what = a.amount === 0n ? "took back the allowance" : a.amount >= UNLIMITED ? "unlimited" : formatAmount(a.amount, r.assets.get(a.token)?.decimals ?? 18);
          const token = r.assets.get(a.token)?.label ?? nameOf(r, a.token);
          return a.amount === 0n ? `${what} of ${nameOf(r, a.spender)} on ${token}` : `allowed ${nameOf(r, a.spender)} to spend ${what} ${token}`;
        }),
      );
    case "failed":
      return `${call} failed; only the gas was spent`;
    case "contract": {
      const parts = [outs.length ? `sent ${summed(r, outs)}` : "", ins.length ? `got back ${summed(r, ins)}` : ""].filter(Boolean);
      if (!e.mine) return `${nameOf(r, e.sender)} called ${call}${parts.length ? `: this wallet ${list(parts)}` : ""}`;
      if (e.target === e.sender && !parts.length) return "a transaction to itself, no money moved";
      return `${call}${parts.length ? `: ${list(parts)}` : ", no money moved"}`;
    }
  }
}

export const when = (r: Report, t: number) => localTime(t, r.period.zone, true);
export const zoneName = (r: Report) => (r.period.zone === "UTC" ? "UTC" : `UTC${r.period.zone}`);

/** The opening paragraph: the part someone reads when they read nothing else. */
export function summary(r: Report): string[] {
  const mine = r.entries.filter((e) => e.mine);
  const gas = mine.reduce((s, e) => s + e.fee, 0n);
  const others = r.entries.length - mine.length;
  const out: string[] = [];
  out.push(
    `Wallet ${r.wallet}, from ${localTime(r.period.from, r.period.zone)} to ${localTime(r.period.to, r.period.zone)} (${zoneName(r)}): ` +
      `Pharos blocks ${r.openBlock + 1n} to ${r.closeBlock}.`,
  );
  if (!r.entries.length) {
    out.push("Nothing touched this wallet in the period.");
  } else {
    out.push(
      `The wallet sent ${mine.length} transaction${mine.length === 1 ? "" : "s"} itself (gas: ${amountOf(r, NATIVE, gas)})` +
        (others ? ` and was on the receiving end of ${others} sent by others.` : "."),
    );
    const parts = r.totals.filter((t) => t.count).map((t) => `${t.count} ${t.count === 1 ? CATEGORY_ONE[t.category] : CATEGORY_TITLE[t.category].toLowerCase()}`);
    out.push(`By kind: ${list(parts)}.`);
  }
  const bad = r.books.filter((l) => !ties(l));
  out.push(
    bad.length
      ? `The books do NOT fully tie: ${bad.length} of ${r.books.length} assets have a gap between what the transactions explain and the closing balance on chain (see "Does it add up").`
      : `The books tie out: for all ${r.books.length} assets the opening balance plus what came in minus what went out (and gas) equals the closing balance read from the chain, to the last unit.`,
  );
  const open = r.approvals.filter((a) => a.left && a.left > 0n).length;
  if (r.approvals.length)
    out.push(`Approvals in the period went to ${r.approvals.length} token and spender pair${r.approvals.length === 1 ? "" : "s"}; ${open} of them still open at the end.`);
  if (r.historyCut) out.push("The explorer lists at most 10,000 rows per kind and this wallet has more, so the 'first contact' check is skipped.");
  return out;
}
