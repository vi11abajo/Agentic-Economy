# 13 · Weekly Digest Agent (Reporting · Medium)

**prosperDigest** is an agent skill that sends a periodic digest of [Prosper](https://pros-per.xyz) (the
bonding-curve launchpad on Pharos mainnet) to your own Telegram chat and/or Discord channel. Weekly by default,
or any day and time, daily, or every N days. Each digest is read from the chain when it is built: what changed,
the key numbers against the previous period, the top 3 notable events with their transactions, and trends across
past digests.

Nothing runs between two digests. The OS scheduler (Task Scheduler, cron or launchd) starts the CLI, the CLI reads
Pharos through Pharos Chain MCP, builds the digest, sends it and exits.

How it's built, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## What a digest holds

- **Key numbers vs the previous period**:
  - volume in PROS (buys and sells), net flow into the curves, trades;
  - traders and new traders (a first Prosper trade ever), fees;
  - new markets, markets that graduated to FaroSwap, markets on the curve.
- **Top 3 events**, scored on one scale: graduations, the largest trade, the largest price move, a new market
  taking a big share of the volume, the largest net buyer. Each event links to its tx on pharosscan.
- **Trends** once 4 digests exist: streaks of rises or falls, and the gap to the 4-period average.
- **The full HTML report**, attached to the Telegram message and kept in `reports/`: every number with last period's,
  tokens by volume with price change and phase, the largest trades, new markets and graduations, and how events
  were picked.

## Real run (Pharos mainnet, 2026-11-02)

The digest of week 44 (Oct 26 - Nov 1 UTC), built by `run --dry` from a fresh data folder, so the week before was
read from the chain too. The Telegram message it makes:

```text
📊 Prosper Weekly · 2026-W44
26 Oct - 01 Nov (UTC), vs the previous week

Key numbers
Volume: 592,139 PROS ▲ 1302%
   buys 298,705 · sells 293,434
Net into curves: +5,270 PROS ▲ 10715%
Trades: 2,248 ▼ 44%
Traders: 874 ▼ 26% · new 837
Fees: 5,947 PROS ▲ 1455%
Markets: +13 new · 0 graduated · 17 on curve

Top 3 events
1. 🐋 0xbA7E…905F bought 5,000 PROS of $ppSUA · tx
2. 🆕 New market $ppFAN took 31% of the volume
3. 🚀 $ppSUA price +28% over the week

Top tokens by volume
$ppFAN 183,682 · $ppAIV 144,250 · $pant 109,928

Read from Pharos mainnet at 2026-11-02 13:44 UTC, blocks 21,261,543 - 21,888,627
```

The largest trade, [0xb8dc43d5…](https://www.pharosscan.xyz/tx/0xb8dc43d54b269832491fc59c014f8d949b2ed0870658212d791e2cb27ce43b41)
in block 21,582,680, is a `Bought` of 5,000 PROS gross (50 PROS fee) on the $ppSUA market. Most traders are new
every week on Prosper: 1,172 of the previous week's 1,188 traders had never traded there before either. The full
report: [examples/prosper-digest-2026-10-26_7d.html](examples/prosper-digest-2026-10-26_7d.html) (also as
[Markdown](examples/prosper-digest-2026-10-26_7d.md)).

## Set up by talking to the agent

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills, such as Claude Code.
Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/13-prosperDigest/skill/prosperDigest`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/13-prosperDigest/skill/prosperDigest -a claude-code
```

Then say "I want a weekly report on Prosper". The agent runs `init` (it creates the `.env` file with empty lines
first), asks where you want the reports, Telegram, Discord or both, and whether you already have a bot or a
webhook. If you do, it tells you the file and the line to fill. If you don't, it walks you through @BotFather or
the Discord webhook settings step by step. You paste the token or the webhook URL into `.env` yourself: the agent
never asks for it in the chat and never prints it. Then it sends a test message, asks when the report should
arrive (Monday 09:00 by default) and installs the schedule.

Data lives in `%APPDATA%\prosperDigest` on Windows, `~/.config/prosperDigest` elsewhere, or `PROSPERDIGEST_HOME`.

## Commands

| Command | What it does |
|---|---|
| `init` | data folder, `.env` with empty lines, config; starts the one-time market scan in the background |
| `channels <telegram\|discord\|both>` | where digests go |
| `test [telegram\|discord\|all]` | a test message; for Telegram it finds your chat id after you `/start` the bot |
| `status` | channels, `.env` lines filled or empty (never values), schedule, scan progress, last digest |
| `schedule set <mon..sun\|daily> <HH:MM> [--every N]` | OS scheduler entries in local time, plus a catch-up every 6 hours |
| `schedule show`, `schedule remove` | what is installed; remove it |
| `run [--dry] [--resend] [--period current]` | build the last closed period's digest now and send it where it hasn't gone |
| `history [--weeks N]` | key numbers of past digests side by side, and trends |

Exit codes: 0 ok, 1 chain or delivery failure, 2 setup needed.

## How the task's requirements are met

| Requirement | Where |
|---|---|
| Runs on a schedule, weekly by default, configurable | `schedule set`: OS scheduler entries (weekly Monday 09:00 by default, any day/time, daily, every N days) and a catch-up for missed or failed runs |
| Key metrics with a comparison to the previous period | every number with the previous period's value and change; the previous period comes from history or is read from the chain on the first run |
| Top 3 notable events | scored candidates, best 3, with tx links; the rules are printed in the HTML report |
| Delivers to a real channel | the user's own Telegram bot (message + HTML report) and Discord webhook (two embeds; Discord would show an attached HTML file as raw code, so it gets none) |

## Limits

- Prosper curve trades only (`Bought` / `Sold` on the markets), not FaroSwap trading after a graduation.
- The first scan reads every Prosper market since the factory's first block, once: 4.4 million blocks, 53
  markets, about 40 minutes through Pharos Chain MCP on 2026-11-02. A digest then reads one period: the first
  one (two weeks, since there is no history yet) took 13 minutes, a later weekly one reads half of that.
- The scheduler entries (schtasks, cron, launchd) are covered by unit tests on their exact commands and files.

## Tests

```bash
cd 13-prosperDigest && npm install && npm run build && npm test
```

Prosper decoding on real logs, the market scan (a market created and traded in the same window, trades logged
before their market, windows never over 1000 blocks), period math across timezones, metrics, events and trends,
the four renderers, Telegram and Discord delivery with secrets redacted from every error, no double send, the
catch-up, a failed channel resent alone, the atomic lock, and the scheduler entries for Windows, Linux and macOS.
