---
name: sonar
description: >
  Watches a list of Pharos mainnet wallets (default: 7 of the biggest PROS holders that are active) and reports
  their significant moves: swaps, entering or leaving a position, sending to or taking out of a contract, plain
  transfers. Each move comes with why it matters, read from the chain at that block: how much of its balance moved,
  the price it got against the PROS/USD feed, whether the other side is another watched whale or a wallet it funded.
  Ends with a summary across all of them. Read-only, no keys. Use for whale watching on Pharos.
version: 2.0.0
requires:
  anyBins:
  - node
---

# sonar

One bundled script, Node 20+: `node scripts/sonar.mjs <command>`. Needs no key and no wallet.

## The watch list

- `node scripts/sonar.mjs discover [--count 7] [--active-hours 48]` picks the biggest PROS holders from the
  pharosscan top accounts list, keeps wallets (no contracts) that were active in that time, and saves them.
- The user can name their own addresses instead: write a `whales.json` like
  `{"minUsd": 1000, "whales": [{"address": "0x…", "label": "…", "minUsd": 5000}]}` and pass `--list <file>`.
  `minUsd` is the "significant" line, for the whole list or per whale.

## Reporting

`node scripts/sonar.mjs report [--hours 24] [--md <file>] [--json <file>]`

Per whale it prints what it holds now (PROS, USDC, WPROS and the dollar total), how many moves, in and out in
dollars, net and stance, the one or two addresses it moved the most with, then each significant move: when, what,
how much, the "why" lines and the tx link. The last two lines are the whole group and the single biggest move.

`node scripts/sonar.mjs watch [--every 300]` prints the report once, then only new significant moves.

## Retelling

- Start from the summary: who moved, how much in total, who just sat.
- For each significant move: the headline as printed, the dollar value, then its "why" lines, then the tx link.
- Patterns are fine to point out when the lines show them (the same two wallets going back and forth, a whale
  paying a wallet it funded itself). Don't name who owns a wallet or why they did it: sonar doesn't know, and
  neither do you.
- Dollar values of PROS use the feed price now; the price line inside a swap uses the feed at that block.
