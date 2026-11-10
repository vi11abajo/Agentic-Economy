// The Markdown report: what a reviewer or an accountant reads first. Same content as the PDF, with links.
import { EXPLORER_ADDRESS, EXPLORER_TX } from "./chain.js";
import { fingerprint } from "./csv.js";
import { CATEGORY_ORDER, CATEGORY_TITLE, NATIVE } from "./ledger.js";
import { UNLIMITED, formatAmount, nameOf, type Report } from "./report.js";
import { ties } from "./tieout.js";
import { amountOf, describe, summary, when, zoneName } from "./words.js";

const txLink = (hash: string) => `[${hash.slice(0, 10)}…](${EXPLORER_TX}${hash})`;
const addrLink = (r: Report, a: string) => `[${nameOf(r, a)}](${EXPLORER_ADDRESS}${a})`;
const esc = (s: string) => s.replace(/\|/g, "\\|");

export function markdown(r: Report, generatedAt: Date): string {
  const md: string[] = [];
  const amt = (asset: string, v: bigint) => formatAmount(v, r.assets.get(asset)?.decimals ?? 18);
  md.push(`# Wallet activity report`, "");
  md.push(`| | |`, `|---|---|`);
  md.push(`| Wallet | [${r.wallet}](${EXPLORER_ADDRESS}${r.wallet}) |`);
  md.push(`| Period | ${when(r, r.period.from).slice(0, 16)} to ${when(r, r.period.to).slice(0, 16)} (${zoneName(r)}) |`);
  md.push(`| Opening state | after block ${r.openBlock} (${when(r, r.openBlockTime)}) |`);
  md.push(`| Closing state | after block ${r.closeBlock} (${when(r, r.closeBlockTime)}) |`);
  md.push(`| Network | Pharos mainnet (chain 1672) |`, "");

  md.push(`## Summary`, "", ...summary(r).flatMap((p) => [p, ""]));

  md.push(`## Does it add up`, "");
  md.push(`Opening and closing balances are read from the chain at the two blocks above. In and out are summed from the transactions below.`, "");
  md.push(`| Asset | Opening | In | Out | Gas | Expected closing | Closing on chain | Result |`, `|---|---:|---:|---:|---:|---:|---:|---|`);
  for (const l of r.books) {
    const result = l.gap === null ? "can't check" : ties(l) ? "✔ ties" : `✘ off by ${amt(l.asset, l.gap)}`;
    const label = r.assets.get(l.asset)?.label ?? l.asset;
    md.push(
      `| ${l.asset === NATIVE ? label : `[${label}](${EXPLORER_ADDRESS}${l.asset})`} | ${amt(l.asset, l.opening)} | ${amt(l.asset, l.in)} | ${amt(l.asset, l.out)} | ${l.fees ? amt(l.asset, l.fees) : ""} | ${amt(l.asset, l.expected)} | ${amt(l.asset, l.closing)} | ${result} |`,
    );
  }
  md.push("");

  md.push(`## Totals by category`, "", `| Category | Transactions | In | Out | Gas paid |`, `|---|---:|---|---|---:|`);
  for (const t of r.totals) {
    const side = (dir: "in" | "out") =>
      [...t.moved]
        .filter(([, m]) => m[dir] > 0n)
        .map(([a, m]) => amountOf(r, a, m[dir]))
        .join("<br>") || "";
    md.push(`| ${CATEGORY_TITLE[t.category]} | ${t.count} | ${side("in")} | ${side("out")} | ${t.fees ? amountOf(r, NATIVE, t.fees) : ""} |`);
  }
  md.push("");

  md.push(`## Worth a second look`, "");
  if (!r.notables.length) md.push(`Nothing stood out.`);
  for (const n of r.notables) md.push(`- ${esc(n.why)}${n.hash ? ` (${txLink(n.hash)})` : n.address ? ` (${addrLink(r, n.address)})` : ""}`);
  md.push("");

  if (r.approvals.length) {
    md.push(`## Approvals given in the period`, "", `| Token | Spender | Given | Left at the end | Tx |`, `|---|---|---:|---:|---|`);
    for (const a of r.approvals) {
      const d = r.assets.get(a.token)?.decimals ?? 18;
      const fmt = (v: bigint | null) => (v === null ? "unknown" : v >= UNLIMITED ? "unlimited" : formatAmount(v, d));
      md.push(`| ${addrLink(r, a.token)} | ${addrLink(r, a.spender)} | ${fmt(a.given)} | ${fmt(a.left)} | ${txLink(a.hash)} |`);
    }
    md.push("");
  }

  md.push(`## Transactions`, "");
  for (const c of CATEGORY_ORDER) {
    const list = r.entries.filter((e) => e.category === c);
    if (!list.length) continue;
    md.push(`### ${CATEGORY_TITLE[c]} (${list.length})`, "", `| Time (${zoneName(r)}) | What happened | Gas | Tx |`, `|---|---|---:|---|`);
    for (const e of list) md.push(`| ${when(r, e.time)} | ${esc(describe(r, e))} | ${e.mine ? formatAmount(e.fee, 18) : ""} | ${txLink(e.hash)} |`);
    md.push("");
  }

  md.push(`## How this was put together`, "");
  md.push(
    `The explorer (socialscan) is only used as an index of which transactions touched the wallet. Token amounts come from each transaction's receipt (Transfer and Approval logs), gas from the receipt too, native PROS from the transaction value and internal calls. Balances are \`eth_getBalance\` and \`balanceOf\` at blocks ${r.openBlock} and ${r.closeBlock} on Pharos RPC.`,
    "",
  );
  md.push(`Generated ${generatedAt.toISOString().replace(/\.\d+Z$/, "Z")} by tieout. Fingerprint of the data: \`${fingerprint(r)}\` (same wallet and period give the same fingerprint).`, "");
  return md.join("\n");
}
