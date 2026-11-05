#!/usr/bin/env node
// receipts: ask about a Pharos wallet, get answers with the contract and block behind every number.
import { readFileSync } from "node:fs";
import { biggest, earning, holdings, inflight, nice, pnl, protocols, render, total, where, type Answer } from "./answers.js";
import { checkAnswer } from "./check.js";
import { REASON_TEXT } from "./facts.js";
import { McpLine } from "./mcp.js";
import { openScan, runScan, saveScan, type Scan } from "./scan.js";

const HELP = `receipts: plain answers about a Pharos wallet, every number with its contract and block. Read-only.

  receipts scan <wallet>        read the wallet's history and its positions at one pinned block (do this first)
  receipts holdings             everything it holds, wallet and protocols, in USD
  receipts where <symbol>       where a token sits (wallet, vaults, pools, requests)
  receipts biggest              the biggest positions by USD value
  receipts total                total USD value and what had to be left out
  receipts pnl [symbol]         what was paid, sold, received, and the profit (tokens held now if no symbol)
  receipts earning              vault earnings so far plus how the held tokens did
  receipts protocols            which protocols hold money now, and which contracts it has called
  receipts inflight             vault requests that haven't paid out yet
  receipts facts [F1 F2 ...]    the fact table (all facts if none given)
  receipts check <file|->       check an answer: every number must carry a fact id and match it

Options: --wallet 0x... (default: the last scanned wallet), --json`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  args.splice(i, 2);
  return value;
}

async function main(argv: string[]): Promise<number> {
  const args = [...argv];
  const json = args.includes("--json");
  if (json) args.splice(args.indexOf("--json"), 1);
  const walletFlag = flag(args, "--wallet");
  const [cmd, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "-h" || cmd === "--help") {
    console.log(HELP);
    return 0;
  }

  const line = new McpLine();
  try {
    if (cmd === "scan") {
      const wallet = rest[0] ?? walletFlag;
      if (!wallet || !/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
        console.error("scan needs a wallet address: receipts scan 0x...");
        return 2;
      }
      const started = Date.now();
      const scan = await runScan(line, wallet);
      saveScan(scan);
      const s = scan.saved;
      if (json) {
        console.log(JSON.stringify({ wallet: s.wallet, block: s.block, holdings: s.holdings.length, total: s.valuation.totalFact, unknowns: s.ledger.unknowns.length, gaps: s.gaps }));
        return 0;
      }
      const t = s.valuation.totalFact ? scan.ledger.byId(s.valuation.totalFact) : undefined;
      console.log(`Scanned ${s.wallet} at block ${s.block}: ${scan.ix.txs.length} transactions and ${scan.ix.transfers.length} token transfers in its history, ${s.checked.tokens} tokens checked, ${s.checked.nonZero} held.`);
      console.log(`Positions found: ${s.holdings.length}. Total that can be priced: ${t ? `$${nice(t.value)} [${t.id}]` : "none"}.`);
      console.log(`Things it can't tell yet: ${s.ledger.unknowns.length} (each comes with its reason in the answers).`);
      if (s.gaps.length) console.log(`Explorer note: ${s.gaps.join("; ")}.`);
      console.log(`Took ${((Date.now() - started) / 1000).toFixed(1)} s and ${line.calls} Chain MCP calls. Ask away: holdings, where <symbol>, biggest, total, pnl, earning, protocols, inflight.`);
      return 0;
    }

    const scan = await openScan(line, walletFlag);
    if (!scan) {
      console.error("No scan yet. Run: receipts scan <wallet>");
      return 2;
    }

    if (cmd === "facts") {
      const ids = rest.length ? rest : scan.ledger.facts().map((f) => f.id);
      const facts = ids.map((id) => scan.ledger.byId(id)).filter(Boolean);
      if (json) console.log(JSON.stringify(facts));
      else for (const f of facts) console.log(`${f!.id}  ${f!.label}: ${f!.value} ${f!.unit} | ${[f!.contract, f!.tx, f!.call].filter(Boolean).join(", ")} | block ${f!.block} | ${f!.source}`);
      return 0;
    }

    if (cmd === "check") {
      const text = !rest[0] || rest[0] === "-" ? readFileSync(0, "utf8") : readFileSync(rest[0], "utf8");
      const verdict = checkAnswer(text, scan.ledger.facts());
      if (json) console.log(JSON.stringify(verdict));
      else console.log(verdict.ok ? "OK: every number in the answer carries a fact id and matches it." : `NOT OK:\n${verdict.problems.map((p) => `  - ${p}`).join("\n")}`);
      return verdict.ok ? 0 : 1;
    }

    const a = await ask(scan, cmd, rest);
    if (!a) {
      console.error(`Unknown command: ${cmd}\n\n${HELP}`);
      return 2;
    }
    saveScan(scan); // pnl and earning add facts; keep them so check can see them
    if (json) {
      const cited = new Set(a.lines.flatMap((l) => [...l.matchAll(/F\d+/g)].map((m) => m[0])));
      console.log(JSON.stringify({ title: a.title, lines: a.lines, facts: scan.ledger.facts().filter((f) => cited.has(f.id)), unknowns: a.unknowns.map((u) => ({ ...u, why: REASON_TEXT[u.reason] })) }));
    } else {
      console.log(render(scan, a));
    }
    return 0;
  } finally {
    await line.close();
  }
}

async function ask(scan: Scan, cmd: string, rest: string[]): Promise<Answer | undefined> {
  switch (cmd) {
    case "holdings":
      return holdings(scan);
    case "where":
      return rest[0] ? where(scan, rest[0]) : undefined;
    case "biggest":
      return biggest(scan);
    case "total":
      return total(scan);
    case "pnl":
      return pnl(scan, rest[0]);
    case "earning":
      return earning(scan);
    case "protocols":
      return protocols(scan);
    case "inflight":
      return inflight(scan);
    default:
      return undefined;
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(`receipts failed: ${(err as Error)?.message ?? err}`);
    process.exit(1);
  },
);
