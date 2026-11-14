# 30 · Whale-Watching Agent

**sonar** follows a list of Pharos mainnet wallets and tells you when they make a big move, what kind of move it
was, and why it might matter. Then it sums up the whole group.

```bash
cd 30-sonar && npm ci && npm run build && npm test
node skill/sonar/scripts/sonar.mjs report --list whales.json --hours 24 --md report.md
node skill/sonar/scripts/sonar.mjs watch --list whales.json --every 300
node skill/sonar/scripts/sonar.mjs discover --count 7 --active-hours 48 --out my-whales.json
```

Read-only: no key, no wallet, no `.env`.

## The whales

`whales.json` here was written by `sonar discover` on 2026-11-14: the pharosscan top accounts list, wallets only
(no contracts), whose row there was updated in the last 24 hours, the first seven.

| | address | PROS that day |
|---|---|---:|
| #26 PROS holder | `0x1793fa30477a624ef2082a87ceec124cff3069d2` | 4,706,305 |
| #30 PROS holder | `0xaad2057ccfa90c1124b1a099d557ab514c663d97` | 3,778,174 |
| #33 PROS holder | `0x4f5528ca5c681abb1afa83c153674e1039b06bde` | 3,190,387 |
| #35 PROS holder | `0x4cad1efbfd5f0848e0c3c14fab23f92b2fa81f17` | 3,140,956 |
| #60 PROS holder | `0xf37483383aeb25cd782a0c38fab281b9552d5c88` | 784,398 |
| #73 PROS holder | `0x00200d064137e5ade3be4926956b3d38c991c3a1` | 410,599 |
| #82 PROS holder | `0x6361b2ae6186875692dadc2a27436c9b4a62b711` | 278,607 |

Any list works: `{"minUsd": 1000, "whales": [{"address": "0x…", "label": "…", "minUsd": 5000}]}`. `minUsd` is
the line for "significant", for the whole list or per whale.

## What a move is

The explorer API gives three lists per address: transactions (PROS sent with a call), internal transactions (PROS
paid out by contracts) and token transfers. sonar folds them into one move per transaction and nets each token,
so a router handing back change doesn't count twice. Then:

| what the whale did in one tx | kind |
|---|---|
| gave token A, got token B | swap |
| gave tokens, got a share token minted | entered a position |
| had a share token burned, got tokens | left a position |
| only gave, to a contract / to a wallet | put into a contract / sent |
| only got, from a contract / from a wallet | took out of a contract / received |

A move is worth its bigger side in dollars: USDC at $1, PROS and WPROS at the Chainlink PROS/USD feed
(`0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466`), other tokens at the explorer's price when it has one.

## Why it matters

Each significant move gets the lines sonar can back with data, and none it can't:
- **How much of its holdings.** The whale's balance of that token at the block before the tx and at the tx's block,
  read with `eth_call` / `eth_getBalance` on the archive RPC. "that was 47% of its PROS: 3,755,968 before, 1,977,451 after".
- **The price it got.** For a PROS/USDC swap, the price per PROS against the feed **at that same block**.
- **The other side.** Another watched whale, by label. Or, for a wallet, when it was first active and who funded
  it first (the explorer's profile), flagged when that funder is the whale itself or another watched one.

Per whale it also prints the one or two addresses it moved the most value with, both directions added up.

## Summary

Per whale: PROS, USDC and WPROS held now (read through Multicall3) and the dollar total, number of moves,
in, out, net, stance (adding, taking out, even, quiet) and the last move. Then one line for the whole group and the
single biggest move. `--md` writes the same as a table, `--json` everything.

## Live run

`report --hours 24` on 2026-11-14 at 18:01 UTC, PROS/USD $0.4722: all 7 whales moved, 231 moves, 21 significant,
in $3,236,357 and out $3,235,242. A few of the lines it printed:

```
#30 PROS holder  0xaad2…3d97
  most with wallet 0xcd60…7067: out $2,436,023, in $2,441,755 over 6 moves
  2026-11-14 14:45  received 1,817,429 PROS from wallet 0xcd60…7067  ($858,112)
      its PROS went from 1,960,745 to 3,778,174 (+93%)
      0xcd60…7067 is a wallet: first active 2026-04-28, first funded by #73 PROS holder
      https://www.pharosscan.xyz/tx/0xa8e9f3cee3d4c122e2b15e84192ac3b9bca1451ccf93c250a6160e4e9f17eb5e

#73 PROS holder  0x0020…c3a1
  2026-11-14 14:59  sent 600,227 PROS to wallet 0x1793…69d2  ($283,402)
      that was 59% of its PROS: 1,011,934 before this tx, 411,707 after
      the other side is another watched whale: #26 PROS holder
      https://www.pharosscan.xyz/tx/0xb66419f4e8d6c4856f150efdb9f1a33c3211d2d22162c54a16a5476eeadc987d
```

What that day shows: most of the big PROS in this group goes round in circles. #30 and the wallet `0xcd60…7067`
sent each other about $2.4M each way in six moves, and `0xcd60…7067` was first funded by #73. #26 and #73 did the
same with each other. The net for the whole group was +$1,115. The 1,817,428.52 PROS in the first tx above is the
`value` of that tx on the RPC (`eth_getTransactionByHash`), from `0xcd60…7067` to `0xaad2…3d97`.

## Layout

`src/pharos.ts` addresses, RPC and explorer clients · `src/history.ts` the three lists folded into moves ·
`src/explain.ts` kind, dollars and the "why" lines · `src/report.ts` per whale and the summary, text and Markdown ·
`src/whales.ts` the list and `discover` · `src/cli.ts` · `skill/sonar/` SKILL.md plus one bundled script.
