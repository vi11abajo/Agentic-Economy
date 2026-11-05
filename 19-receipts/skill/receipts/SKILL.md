---
name: receipts
description: >
  receipts: answers questions about one Pharos wallet (what it holds, where a token sits, what it is worth, how a
  token trade went, what vaults and staking are earning, which vault requests have not paid out, which protocols
  it uses) with the contract and block behind every number. History comes from the Pharos explorer, every amount
  and price is read on chain through the Pharos Chain MCP at one pinned block. When it can't know something it
  says why, from a fixed list of reasons. Read-only: no keys, no signing, no sending. Use whenever the user asks
  about a Pharos wallet's balances, positions, yields, profit and loss, or "what happened to my tokens".
version: 1.0.0
requires:
  anyBins:
  - node
---

# receipts

Run with Node 20+ from this skill's folder: `node scripts/receipts.mjs <command>` (use the absolute path of
`scripts/receipts.mjs` from elsewhere). One bundled file, no install, no keys. It talks to the Pharos Chain MCP
(https://mcp.pharos.xyz/mcp) and the Pharos explorer API on its own. Data folder: `RECEIPTS_HOME` if set, else
`%APPDATA%\receipts` or `~/.config/receipts`.

## Always scan first

`receipts scan <wallet>` reads the wallet's history and every position at one pinned block and saves it. Every
question afterwards answers from that same block, with the same fact ids. Scan again when the user asks about a
different wallet or wants fresh numbers. A big wallet takes up to a minute; say so before you start.

## Questions

- `holdings`: everything it holds, in the wallet and inside protocols, in USD, with a total.
- `where <symbol>`: where a token sits (wallet, vaults, pools, pending requests).
- `biggest`: the biggest positions by USD value.
- `total`: total USD value and what had to be left out of it.
- `pnl [symbol]`: what was paid, sold, received, and the profit; without a symbol, every token held now.
- `earning`: what vaults and staking earned so far, plus how the held tokens did.
- `protocols`: which protocols hold money now, and which contracts the wallet has called.
- `inflight`: vault deposit and redeem requests that have not paid out yet.
- `facts [F1 F2 ...]`: the fact table. `check <file|->`: checks a draft answer.

Pick the command from the user's words. "My wallet" is the address they gave. Several questions in one message
mean several commands. `--json` gives the same answer as data.

## How to answer

1. Answer in plain words, short, built only from what the commands printed. Do not add numbers of your own
   except sums, differences and percent changes of printed numbers.
2. Every number you write carries the fact id it comes from, like `$4.09 [F45]`. For a sum or a percent, cite
   all the facts it uses. The user can open any fact: it names the contract, the call or the tx, and the block.
3. Before you send the answer, pipe your draft into `receipts check -`. If it says NOT OK, fix the numbers it
   names (or drop them) and check again. Never send an answer that failed the check.
4. Every "can't tell" in the output has a reason. Pass it on in plain words: why it can't be known, and what
   would be needed to know it. "I don't know" alone is never an answer.
5. A token that came in by transfer was not bought by this wallet. Say so: its real profit can't be known here;
   only the price change since it arrived can be shown, and that is not earnings.
6. If the explorer served fewer rows than it says exist, mention it once, with its fact ids, and say that each
   token's history is checked against its on-chain balance before any profit figure is given.

## Never

Never sign or send a transaction, never ask for a private key or seed phrase: receipts has no signing code at
all. Never tell the user to buy, sell or move anything; you describe what happened and what is there now.
