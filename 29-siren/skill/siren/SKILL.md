---
name: siren
description: >
  Watches Pharos mainnet (chain 1672) and sends an alert to Telegram and/or Discord when a rule matches: an ERC-20
  transfer above a size (USDC, WPROS or any token address), the Chainlink PROS/USD feed crossing a line, or a
  successful call to a contract (by selector or function signature, optionally with a minimum PROS value). Every
  alert says what happened, the amount and an explorer link. Never repeats an alert, even across restarts. Bot
  token and webhook stay in siren's own .env. Use when someone wants to be told about something on Pharos.
version: 2.0.0
requires:
  anyBins:
  - node
---

# siren

One bundled script, Node 20+: `node scripts/siren.mjs <command>`.

## Setting up

1. `node scripts/siren.mjs init`: makes siren's folder with an empty `.env` and an example `rules.json`, and
   prints both paths.
2. The user opens that `.env` themselves and pastes the Telegram bot token and/or the Discord webhook URL.
   Never ask for them in chat, never read the file out, never put them on a command line.
3. Telegram only: the user sends `/start` to their bot, then `node scripts/siren.mjs connect` saves the chat.
4. `node scripts/siren.mjs test` must show a ✓ per channel. A ✗ comes with a hint: pass it on as it is.

## Rules

`rules.json` is a list. Each rule has a `name` and a `kind`:
- `transfer`: `token` (USDC, WPROS or an ERC-20 address), `min` in whole tokens, optional `from` / `to`.
- `price`: `feed` (PROS/USD or a feed address), exactly one of `above` / `below`, optional `rearm` (default 0.005:
  after firing, the price has to come back past the line by 0.5% before the rule can fire again).
- `call`: `to`, optional `selector` (0x + 8 hex) or `function` (like `withdraw(uint256 wad)`, then the arguments
  are decoded into the alert), optional `minValue` in PROS, optional `label`.

Edit the file for what the user wants, then `node scripts/siren.mjs rules`. It checks every rule on chain (the
token answers symbol/decimals, the feed answers) and shows the live price next to price rules. Fix what it rejects.

## Watching

- `node scripts/siren.mjs watch` runs until Ctrl+C, one round every `pollSeconds` (default 10). On its first run it
  starts at the current block.
- `--since <blocks>` on a first run reads that many blocks back, to show what the rules would have caught. Pharos
  makes a block about every 0.84 s, so 4000 blocks is about an hour and 100000 about a day. At whale-sized lines a
  quiet hour can catch nothing; a day is the better look back.
- `--once` reads up to the current block and stops (a round takes at most 10,000 blocks, so a `--since` day is
  a few rounds, about 4 minutes). `--console-only` only prints, even when a channel is set up; what it prints counts
  as alerted, so a later run won't send it again.
- `node scripts/siren.mjs status`: last block read, how many events were alerted, what is still waiting.

Each round prints one line: the block range, how many new alerts, how many were delivered. A channel that fails
keeps the alert in the outbox and retries next round, without resending to the channels that already got it.

## Retelling an alert

Say what the rule saw, the amount, and give the tx link from the alert. For a price alert say the line, the price
and when the feed last updated. Don't add meaning the alert doesn't carry (who a wallet belongs to, why it moved).
