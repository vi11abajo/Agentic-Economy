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
- `lastcall watch --wallet 0x... [same thresholds] [--every 60] [--rounds N] [--console-only]`: the same
  in a loop. Speaks up on a worse level, a recovery, a carry clock under `--days-warn` days, or a rule change
  by the pool's admin since the last round. Alerts go to the console and to every channel filled in
  `alerts.env` (see below). Remembers levels in `.state/watch.json` next to this file, so a restart doesn't
  repeat old alerts. Without `--rounds` it runs until stopped: start it in the background and tell the user
  how to stop it.
- `lastcall replay --pool avalon|avalon-innovative|openfi|zona --wallet 0x... --block N`: the rule-change
  alert for a change that already happened in block N (Avalon's Safe swapped the rate strategies in block
  22302862).
- `lastcall scan [--hours 24] [--top 15]`: borrowers seen on every venue in the last hours, ranked by health.
  One log query per 999 blocks (about 17 minutes of chain). A 7-day scan took about an hour on 2026-11-06,
  so use 24 h unless the user asks for more, and tell them how long it will take before starting.
- `lastcall channels [test]`: where alerts go. `test` sends a test message to whatever is set up and, after
  the user pressed Start on their bot, finds their Telegram chat id by itself.

## Setting up Telegram, Discord or both

Alerts always go to the console with a timestamp. To get them on the phone as well, the user fills lines in
**`alerts.env`, the file in this skill folder next to SKILL.md**. It ships with three empty lines and comments:

| Line | What goes there | Needed for |
|---|---|---|
| `LASTCALL_TELEGRAM_BOT_TOKEN=` | the bot token from @BotFather, like `110201543:AAHdqTcv...` | Telegram |
| `LASTCALL_TELEGRAM_CHAT_ID=` | nothing: lastcall fills it in itself (step 5 below) | Telegram |
| `LASTCALL_DISCORD_WEBHOOK=` | the channel webhook URL, `https://discord.com/api/webhooks/...` | Discord |

Telegram only, Discord only, or both: each channel switches on by itself once its line is filled, no flag
needed. An empty line means that channel stays off.

Do it with the user step by step:

1. Run `lastcall channels`. It prints the full path of `alerts.env` (and recreates it if it was deleted) and
   says which channels are on. Give the user that exact path.
2. Ask: "Where do you want the alerts: Telegram, Discord, or both?"
3. For each chosen channel ask whether they already have a bot or a webhook, or want help making one.
   - **They have one:** tell them which line to fill (table above). They paste the value right after `=`, no
     quotes, no spaces, and save the file.
   - **Help with Telegram:**
     1. In Telegram open @BotFather and send `/newbot`.
     2. Send a name for the bot (anything, e.g. "My loan watchdog").
     3. Send a username: 5-32 Latin letters, digits or `_`, ending in `bot` (e.g. `my_loan_watchdog_bot`).
     4. BotFather answers with a token like `110201543:AAHdqTcv...`. Copy it into `LASTCALL_TELEGRAM_BOT_TOKEN=`.
     5. Open the new bot (the t.me link BotFather gives) and press Start, or send `/start`. Without this the
        bot isn't allowed to write to them.
   - **Help with Discord:**
     1. Open the server's Server Settings, then Integrations.
     2. Create a webhook (Create Webhook / New Webhook), pick the text channel it should post to.
     3. Press Copy Webhook URL and paste it into `LASTCALL_DISCORD_WEBHOOK=`.
     4. If Integrations isn't there, they need a server where they can manage webhooks (their own server works).
4. Never ask for the token or the webhook in the chat, and never read, print or `cat` `alerts.env`: anyone with
   these can post as the bot. If one gets pasted into the chat anyway, don't repeat it and suggest replacing it
   with a new token or a new webhook.
5. When they say the file is saved, run `lastcall channels test`. For Telegram it first finds the chat that
   pressed Start and writes `LASTCALL_TELEGRAM_CHAT_ID` itself, then every filled channel gets a test message.
   Ask the user whether it arrived. If it says "no /start message found", they need to press Start in the bot
   and you run the test again. If a channel says FAILED, read them the reason and go back to step 3 for it.
6. From then on `watch` and `replay` send to every filled channel, as a card: a colour for the level and one
   short field per question (loan, price risk, time left, what to do, rules). `--console-only` keeps a single run off them.

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
