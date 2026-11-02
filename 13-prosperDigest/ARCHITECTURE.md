# prosperDigest: architecture

prosperDigest turns Prosper's on-chain activity into a periodic digest and sends it to the user's own Telegram
chat and/or Discord channel. It runs on the machine where the agent runs. Between two digests nothing of it is
running and nothing is read: the OS scheduler starts the CLI, the CLI reads the chain for the period that just
ended, builds the digest, sends it and exits.

```text
   agent (Claude Code + the prosperDigest skill)
     |  init / channels / test / schedule set / run / history      (setup is a conversation, see SKILL.md)
     v
   OS scheduler (Task Scheduler / cron / launchd)
     |  at the user's day and time: run;  every 6 hours: run --catch-up
     v
   run.cmd / run.sh (data folder) -> prosperDigest.mjs run
     |
     |  period.ts   last closed period (whole UTC days from an anchor), when it is due
     |  scan.ts     markets.json + traders.json brought up to the period, then the period's logs
     |  chain.ts    Pharos Chain MCP: get_logs (1000-block windows), eth_call phase(), get_block
     |  metrics.ts  key numbers;  events.ts top 3;  trends.ts patterns across history.jsonl
     |  render.ts   Telegram HTML, Discord embeds, the HTML report, Markdown copy
     |  deliver.ts  Telegram Bot API (sendMessage + sendDocument), Discord webhook (?wait=true)
     v
   the user's Telegram bot -> their chat;  the user's webhook -> their Discord channel
```

## What is read, and when

Prosper markets are created by the ProsperFactory (`0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8`,
`MarketCreated`). Every market emits `Bought` / `Sold` for curve trades and has `phase()` (0 on curve,
1 migrating, 2 graduated to FaroSwap, 3 curve only). The event signatures and the `phase()` selector come from
`services/prosper-monitor` in this repo; this folder has its own copy and shares no code with it.

A digest needs two things before it can read a period:

- **the list of markets**, so a `Bought` from any other contract is not counted. Every Prosper market since the
  factory's first block is kept in `markets.json`;
- **every trader's first trade block**, so "new traders" means a first Prosper trade ever, not first in our
  memory. Kept in `traders.json`.

Both come from one walk over the chain, done once in the background by `init` and then extended by each run up to
the period it reads. Each 1000-block window is one `get_logs` call with the three topics and no address filter
(so the cost does not grow with the number of markets); logs are kept only when they come from the factory or a
known market. Each window is processed in two passes, markets first and trades second, so a market created inside
a window counts its trades from that same window even if one was logged before its `MarketCreated`.

Then the period itself: its first and last block are found by timestamp (`get_block`, a guess at one block a
second, then bisection), its windows are read the same way, and `phase()` is called at the period's last block for
every market that existed then, and at its first block for those not on the curve at the end. A market seen in a
final phase (graduated or curve only) is not asked again for later blocks.

The previous period's numbers come from `history.jsonl` when the last digest covered it; otherwise (first run)
that period is read from the chain too.

A `get_logs` answer takes about 2.4 s and the MCP allows about 2 calls a second, so six windows are asked for at
once; the MCP client paces them under 115 calls a minute and they are processed one by one in order.

## Periods and the schedule

Periods are whole UTC days tiled from an anchor date, `days` long: 7 by default. For weekly digests the anchor
follows the schedule: periods end at the UTC midnight right before the scheduled local time, so Monday 09:00 in
Europe gets Monday-to-Sunday weeks, Friday 18:00 gets Friday-to-Thursday, and Monday 09:00 east of UTC (Sunday
night in UTC) still gets the week that just ended. The key of a period is `<first day>_<N>d`, e.g.
`2026-10-26_7d`; history, the reports and the "already sent" check all use it. The schedule's day and time are
the machine's local time: a digest is due at the first scheduled time after its period ends.

Two scheduler entries call the launcher in the data folder: the report at the user's day and time, and a catch-up
every 6 hours. The catch-up sends a digest that is due but was missed (the machine was off) and resends one whose
send failed; when nothing is due it exits without reading the chain. For periods other than 7 days the report
entry fires daily and a run with nothing new due is a no-op.

## Delivery

- **Telegram**: the user's own bot. `sendMessage` with HTML formatting (the summary) and `sendDocument` (the full
  HTML report). The chat id is found by `test`: after the user sends `/start` to the bot, `getUpdates` gives the
  chat, and its id is written into `.env`.
- **Discord**: the user's webhook. One `multipart/form-data` POST with `payload_json` (two embeds: key numbers,
  top events and trends) and the HTML report as `files[0]`, with `?wait=true` so the answer confirms the message.

Each channel is independent. A send is retried inside the run (after 1, 4 and 10 minutes); if it still fails the
digest is marked failed for that channel and the catch-up sends it later. Telegram's two calls are retried
separately: once the summary is out only the file is retried, so the summary never arrives twice.

Only one prosperDigest process works at a time: the lock file is created atomically (`wx`), and the catch-up fires
at minute 17, so it never starts in the same second as a report scheduled on the hour. A closed period is read only
once the chain is past its end; until then the run fails, writes why in `run.log`, and the catch-up tries again. A digest is never sent twice to the same
channel unless `--resend`. The bot token and the webhook URL are never printed: every error passes through
`redact()`, because Node's fetch errors can carry the URL and Telegram's URL carries the token.

## Events and trends

Each candidate event gets a score; the best three are shown, at most one per kind except graduations:

| Event | Score |
|---|---|
| a market graduated to FaroSwap | 100 |
| the largest trade, if at least 5x the median trade | 10 x that ratio, at most 90 |
| the largest price move (token with 10+ trades and 1%+ of the volume) | half the % move, at most 80 |
| a new market with 5%+ of the volume | 50 x its share |
| the largest net buyer with 5%+ of the volume | 50 x that share |

Trends need at least 3 earlier digests of the same length: a streak of 3+ rises or falls in a row, and the gap to
the average of the last 4, when it is 20% or more, for volume, trades, traders and net flow.

## Files

| File | What |
|---|---|
| `.env` | `PROSPERDIGEST_TELEGRAM_BOT_TOKEN`, `PROSPERDIGEST_TELEGRAM_CHAT_ID`, `PROSPERDIGEST_DISCORD_WEBHOOK`; created with empty lines, filled by the user |
| `config.json` | channels, schedule (days, weekday, time, tz, anchor), top tokens |
| `markets.json`, `traders.json` | the market list and first trade blocks, with the last block scanned |
| `history.jsonl` | one line per digest: every number, the events and their candidates, delivery per channel |
| `reports/` | `prosper-digest-<key>.html` and `.md` |
| `run.log` | every run step, send and failure |
| `run.cmd` / `run.sh` | the launcher the scheduler calls |
