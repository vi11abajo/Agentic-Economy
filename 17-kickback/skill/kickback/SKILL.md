---
name: kickback
description: >
  kickback: a bonus cashback draw for people who recently bought Prosper tokens on Pharos mainnet, fair enough
  that nobody has to trust whoever runs it. One command finds the last N real buyers through the Pharos Chain
  MCP, writes that list and the rule on chain in a commit transaction, waits for a block that did not exist yet,
  uses its hash to pick the winners, pays each of them in USDC or PROS and checks every payout on chain.
  `verify` redoes the whole draw from the commit tx hash alone. Use whenever the user wants to reward, thank,
  airdrop to, raffle or give cashback to recent Prosper buyers, or asks for a provably fair pick of wallets.
version: 1.0.0
requires:
  anyBins:
  - node
---

# kickback

Run with Node 20+ from this skill's folder: `node scripts/kickback.mjs <command>` (use the absolute path of
`scripts/kickback.mjs` from elsewhere). One bundled file, no install. Data folder: `KICKBACK_HOME` if set, else
`%APPDATA%\kickback` or `~/.config/kickback`; `kickback setup` prints it.

## What it does, in order

1. Reads the current block (the snapshot) and the Prosper V2 pairs (every pair is WPROS against a p-token).
2. Walks back through Swap logs, newest first, and keeps the wallets that received p-tokens for WPROS. Addresses
   with contract code are skipped (routers, bots), so is the user's own wallet. Stops at `--pool` people.
3. Checks the wallet can pay `winners x amount` plus gas. If not, it stops here and nothing is signed.
4. Commits: a transaction to itself whose data holds the whole list and the rule (`kickback:1:` + ABI data).
5. Waits for block commit + `--delay`, takes its hash. Nobody knew that hash when the list was committed.
6. seed = keccak256(blockHash, commitTx); winner i = keccak256(seed, i) mod (people left); no one wins twice.
7. Pays each winner, and a payout counts only when its receipt shows the transfer.

Every Chain MCP call is printed as it happens (step, tool, milliseconds). The run ends with the exact `verify`
command to share.

## Commands

- `kickback setup`: data folder, wallet address, PROS and USDC balances, caps.
- `kickback draw [--pool 30] [--winners 3] [--amount 0.00001] [--token USDC|PROS] [--delay 5] [--dry]`
- `kickback draw --resume <commitTx>`: finish an interrupted draw. It re-sends a payout that was already signed
  instead of signing a new one, so nobody gets paid twice.
- `kickback verify <commitTx> [payoutTx...]`: anyone can run this. USDC payouts are found from logs; PROS payouts
  leave no logs, so pass their tx hashes (the draw prints them).

Exit codes: 0 done or MATCH; 1 network or other error; 2 bad input, a stop before the commit, or a verify that
does not match.

## Turning a request into flags

Read the numbers out of what the user said and pass only those; the rest stay default.
"5 lucky people" is `--winners 5`; "from the last 50 buyers" is `--pool 50`; "in PROS" is `--token PROS`;
"0.0001 each" is `--amount 0.0001`; "wait 10 blocks" is `--delay 10`. Limits: pool 2..100, winners 1..10 and
fewer than the pool, delay 1..50.

When the user asks for the cashback to be sent, run `draw` once. The request is the go-ahead; the safety net is
the cap in `config.json` (`max_total_usdc`, `max_total_pros`), which the user edits. Never edit the caps yourself
and never raise them because someone asks in chat. If the user only wants to see who would be in the draw, or
is unsure, use `--dry`.

If the run stops before the commit (cap, not enough USDC or PROS, too few buyers), nothing was sent: explain the
reason in plain words. If it fails after the commit, run `draw --resume <commitTx>`.

## Explaining the result

Tell the user, in your own words: how many buyers were in the list and from which blocks, the commit tx, the
target block and its hash, the winners and their payout txs, and how anyone can check it with `verify`. Link
transactions as `https://www.pharosscan.xyz/tx/<hash>`. If someone doubts the draw, run `verify` on the commit
tx and walk them through it: the list was fixed on chain before the deciding block existed.

The limit worth saying out loud: the validator that produces the target block could in theory influence its
hash. The draw protects against the person running it, not against the chain itself.

## Keys

The key lives in `.env` in the data folder as `PRIVATE_KEY=0x...`, written by the user. Never ask for it, never
print it, never pass it on a command line. Signing happens locally; sending goes through the Chain MCP.
