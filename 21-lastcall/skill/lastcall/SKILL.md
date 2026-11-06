---
name: lastcall
description: >
  lastcall: a liquidation watchdog for lending positions on Pharos mainnet (Morpho Blue markets and the Avalon,
  OpenFi and Zona Aave forks). Reads a wallet's collateral, debt and health factor from chain, grades it against
  warning and critical thresholds, and says how much time is left two ways: how far a volatile collateral's
  price can fall, and, for NAV-priced vault collateral whose oracle only climbs, how many days the carry (borrow
  rate vs collateral growth) leaves, now and if the market's suppliers pulled their spare cash. Every alert
  carries a repay amount and a top-up amount that lastcall first rehearsed on the real contracts as the
  borrower (state-override eth_call), plus what the wallet holds of that token. It also catches admin rule
  changes on the Aave forks (rate strategy, thresholds, price source) in the block they land and shows the
  loan before vs after. Alerts go to the console with timestamps and to Telegram and/or Discord. Read-only:
  no keys, nothing is signed or sent. Use when someone asks whether a loan on Pharos is safe, how close it is
  to liquidation, what to repay, or wants to be warned before it gets liquidated.
version: 1.0.0
requires:
  anyBins:
  - node
---

# lastcall

Run with Node 20+: `node scripts/lastcall.mjs <command>` (use the absolute path of `scripts/lastcall.mjs` from
elsewhere). One bundled file, no install, no keys. Reads Pharos mainnet through https://rpc.pharos.xyz;
`PHAROS_RPC_URL` overrides it.

## Commands

- `lastcall look --wallet 0x... [--wallet 0x...] [--warn 1.3] [--critical 1.1] [--target 1.5] [--days-warn 30] [--json out.json]`:
  every open loan of the wallet(s), one table plus a full alert per loan. 30-60 s for a few wallets; say so
  before running it.
- `lastcall watch --wallet 0x... [same thresholds] [--every 60] [--rounds N] [--telegram] [--discord]`: the same
  in a loop. Speaks up on a worse level, a recovery, a carry clock under `--days-warn` days, or a rule change
  by the pool's admin since the last round. Remembers levels in `.lastcall/state.json` (`LASTCALL_HOME` moves
  the folder), so a restart doesn't repeat old alerts. Without `--rounds` it runs until stopped: start it in
  the background and tell the user how to stop it.
- `lastcall replay --pool avalon|avalon-innovative|openfi|zona --wallet 0x... --block N`: the rule-change
  alert for a change that already happened in block N (Avalon's Safe swapped the rate strategies in block
  22302862).
- `lastcall scan [--hours 24] [--top 15]`: borrowers seen on every venue in the last hours, ranked by health.
  One log query per 999 blocks (about 17 minutes of chain). A 7-day scan took about an hour on 2026-11-06,
  so use 24 h unless the user asks for more, and tell them how long it will take before starting.
- `lastcall channels [test]`: where alerts go. `test` sends a test message to whatever is set up and, after
  the user pressed Start on their bot, finds their Telegram chat id by itself.

## Setting up Telegram or Discord

Run `lastcall channels` once: it creates `.lastcall/.env` with three empty lines. Explain to the user how to
fill them, in your own words:
- Telegram: talk to @BotFather, `/newbot`, copy the token into `LASTCALL_TELEGRAM_BOT_TOKEN=`; open the new bot
  and press Start; then `lastcall channels test` fills in the chat id.
- Discord: channel settings, Integrations, Webhooks, New Webhook, Copy Webhook URL into `LASTCALL_DISCORD_WEBHOOK=`.
The user pastes these into the file themselves. Never ask for the token or webhook in chat, never print or
read them back. If one gets pasted into the chat anyway, don't repeat it and suggest making a new one.

## How to read an alert

1. Level and health factor first. 1.0 is where liquidation starts; the thresholds are the user's choice.
2. The price line. For volatile collateral (FBTC, WPROS) it says how far the price can fall. For vault shares
   whose oracle only climbed over the last week (syzUSD, wsrUSD, strUSD and the like) it says a price drop
   isn't the risk, and the carry line matters instead. Collateral in the same token as the debt cancels out.
3. The carry lines: how fast health grows or shrinks at today's rates, and the "if every spare unit of supply
   left" case, where the borrow rate is the one the market's own rate model gives at 100% use. Present that
   as a stress case, not a forecast. Morpho's adaptive rate model would keep raising the rate the longer the
   market stays full, so the real stress clock would run out sooner; lastcall doesn't model that.
4. The action: repay X or add Y. Each was rehearsed on the real pool or Morpho contract at that block, as the
   borrower, and the health printed after the arrow is what the contract itself computed. "You hold" is the
   wallet's real balance; if it's short, the rehearsal topped the balance up only inside the simulation.
   When the clock is short, the aim is raised above the target so the fix buys at least twice `--days-warn`.
5. Rules. Morpho markets: fixed, checked by hashing the market's params into its id. Aave forks: who can
   change them (Avalon: a 3-of-5 Safe with no timelock), which is why lastcall watches their admin contracts.

Use only numbers lastcall printed. It never moves money: the borrower repays or tops up from their own wallet.
