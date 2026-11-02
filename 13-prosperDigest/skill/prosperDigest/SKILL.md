---
name: prosperDigest
description: >
  prosperDigest: a scheduled digest of Prosper (bonding-curve launchpad on Pharos mainnet) activity, sent to the
  user's own Telegram chat and/or Discord channel. Weekly by default, any day/time or every N days. Each run reads
  the chain right then: volume, buys/sells, net flow into curves, trades, traders and new traders, fees, new
  markets, graduations to FaroSwap, compared with the previous period, plus the top 3 notable events with tx links
  and trends across past digests. Use when the user wants Prosper or Pharos launchpad reports, a weekly digest,
  scheduled summaries of Prosper activity, or asks how Prosper did lately.
requires:
  anyBins:
  - node
---

# prosperDigest

Run with Node 20+ from this skill's folder: `node scripts/prosperDigest.mjs <command>` (use the absolute path of
`scripts/prosperDigest.mjs` when running from elsewhere). One bundled file, no install, no keys for reading the
chain.

| Command | What it does |
|---|---|
| `init` | creates the data folder, a `.env` with empty lines for the bot token / webhook, the config, and starts the one-time market scan in the background (about 40 min) |
| `channels <telegram\|discord\|both>` | where digests go |
| `test [telegram\|discord\|all]` | sends a test message; for Telegram it also finds the chat id after the user sent `/start` to the bot |
| `status` | channels, which `.env` lines are filled (never their values), schedule, scan progress, last digest |
| `schedule set <mon..sun\|daily> <HH:MM> [--every N]` | installs the OS scheduler entries (local time) plus a catch-up check every 6 hours |
| `schedule show` / `schedule remove` | what is installed / remove it |
| `run [--dry] [--resend] [--period current]` | builds the last closed period's digest now and sends it where it hasn't gone yet; `--dry` builds without sending; `--period current` is the period so far |
| `history [--weeks N]` | key numbers of past digests side by side, and trends |

## Setup: do it with the user step by step, in this order

1. Run `init` first, so the `.env` file exists before you ask anything. Note its full path from the output.
2. Ask: "Where do you want to receive the reports: Telegram, Discord, or both?" Run `channels <answer>`.
3. For each chosen channel ask: "Do you already have a Telegram bot (or a Discord webhook), or should I help you
   set one up?"
   - **They have one:** tell them the full path of the `.env` file and the exact line to fill:
     `PROSPERDIGEST_TELEGRAM_BOT_TOKEN=` (Telegram) or `PROSPERDIGEST_DISCORD_WEBHOOK=` (Discord). They paste the
     value after `=` and save. The chat id line stays empty.
   - **They need help with Telegram:** give these steps, then the line above:
     1. In Telegram open @BotFather and send `/newbot`.
     2. Send a name for the bot (anything, e.g. "My Prosper Digest").
     3. Send a username: 5-32 Latin letters, digits or `_`, ending in `bot` (e.g. `my_prosper_digest_bot`).
     4. BotFather answers with a token like `110201543:AAHdqTcv...`. Copy it.
     5. Open the new bot (the t.me link BotFather gives) and press Start, or send `/start`.
   - **They need help with Discord:** give these steps, then the line above:
     1. Open the server's Server Settings, then Integrations.
     2. Create a webhook (Create Webhook / New Webhook), pick the text channel it posts to, optionally rename it.
     3. Press Copy Webhook URL.
     4. If Integrations is not there, they need a server where they can manage webhooks (their own server works).
4. Never ask the user to paste a token or webhook into the chat, and never read, print or `cat` the `.env` file.
   The token and webhook are secrets: anyone with them can post as the bot.
5. When they say the file is filled and saved, run `test`. If a channel fails, read them the "what to do" line and
   go back to step 3 for that channel. For Telegram "no /start found": they must open their bot and send `/start`.
6. After the test passes, ask when the report should arrive: default Monday 09:00 (their local time), weekly. Any
   day and time works, or `daily`, or every N days (`--every N`, the report then covers N days). Run
   `schedule set ...` and show what it installed.
7. Run `status` and tell them when the first digest is due and how far the market scan is. The first digest can
   only be built once the scan is done; scheduled runs wait for it.

## Using it

- "Send it now" / "show me this week's digest": `run` (or `run --dry` to only build it; the report file path is
  printed). `run` never sends the same period twice to a channel; `--resend` forces it.
- "How did Prosper do lately?", "is volume growing?": `history`, then answer from its table and trends.
- "Change the time / send on Fridays": `schedule set fri 18:00`. "Stop the reports": `schedule remove`.
- "Add Discord too": step 3 for Discord, `channels both`, `test discord`.
- Never cut CLI output with head/tail/grep; it is short and the user may need all of it.

## What a digest holds

Key numbers of the period with the previous period's value and change: volume in PROS (buys + sells), net flow
into curves (buys minus sells), trades, traders and new traders (first Prosper trade ever), fees, new markets,
markets that graduated to FaroSwap, markets on curve. Top 3 events (graduations, the largest trade, the largest
price move, a new market taking a big share, the largest net buyer) with tx links. Trends once there are 4+
digests. The full HTML report is attached to the message and kept in the data folder's `reports/`.

Periods are whole UTC days (Monday to Sunday for the weekly default). Data comes from Pharos Chain MCP
(mcp.pharos.xyz) at the moment the digest is built; between runs nothing runs and nothing is read.
