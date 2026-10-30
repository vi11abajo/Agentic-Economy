# 10 · Trend Watcher (SkillEngine · Hard)

**trendwatch** is an agent skill with memory. It watches a price over time, keeps every observation on disk,
and signals only once a trend holds for several observations in a row, not on one noisy reading. It works for
any token: any instrument on OKX (public candles, no key), or a V3 pool on Pharos read through the Pharos Chain
MCP. The examples here watch PROS.

## How it works

- **Observations.** `okx:<instId>`: one per closed candle (`--bar`, 15m by default). `pharos-pool:<address>`:
  the price of `--base` in the pool from `slot0`, one every `--every-blocks` blocks, read at those exact blocks.
  Only closed candles and past blocks are stored, so an observation never changes after it's written.
- **Rules**, set per watch:
  - `consecutive`: n closes in a row moving down (or up), optionally at least `--min-move` % in total;
  - `ema`: the close below a falling EMA30 (above a rising one) on every timeframe in `--timeframes`, n
    observations in a row. EMA30 starts from the average of the first 30 closes, then k = 2/31.

  n is at least 3; `add` and `set` refuse less.
- **One spike doesn't make a trend.** A move bigger than `--spike-atr` (2.5) times the ATR30 is held: it can't
  complete a streak on its own. If the next observation takes back more than half of it, it's marked
  `spike ignored` and counts for nothing; if not, `spike confirmed` and it counts. Measuring in ATRs instead of a
  fixed percent keeps the same rule sensible for a quiet token and a wild one.
- **It fires once.** When the streak reaches n, that observation is the signal. The streak has to break before
  the same watch can fire again.

## Memory, restarts

Each watch is a folder: `watch.json` (source and rule), `observations.jsonl`, `signals.jsonl`, and for the EMA
rule the candles of each timeframe. Every line has a key (the candle's open time, or the block number):

- **Nothing lost.** Each run asks the source for everything after the last stored key, so after a stop it loads
  what it missed.
- **Nothing twice.** A key that's already stored is never written again, and a signal is recorded once per key.
- **A crash mid-write** leaves at most a cut-off last line; the next run drops it and fetches that observation
  again.
- **One run at a time:** a lock file, taken over after 15 minutes if a run died holding it.
- The decision is a pure function of the stored history, so the same observations always give the same marks
  and signals. `history` shows them, with `<== TREND CONFIRMED` at the observation where the rule was met.

## Real PROS data (2026-10-30)

`add pros okx:PROS-USDT --bar 1H --since 2026-10-26 --n 3 --min-move 1` loaded 117 hourly candles and found the
times PROS fell three hours in a row by at least 1% in total. Part of `history pros`:

```text
  time                      close   change  streak  mark
  2026-10-30 00:00 UTC    0.59710   -0.99%     1/3  counts
  2026-10-30 01:00 UTC    0.59230   -0.80%     2/3  counts
  2026-10-30 02:00 UTC    0.58470   -1.28%     3/3  counts  <== TREND CONFIRMED
  2026-10-30 03:00 UTC    0.59240   +1.32%     0/3  against
  2026-10-30 04:00 UTC    0.58480   -1.28%     1/3  counts
  2026-10-30 05:00 UTC    0.57790   -1.18%     2/3  counts
  2026-10-30 06:00 UTC    0.58040   +0.43%     0/3  against
```

On 15-minute candles a spike stopped a false signal. Two lower closes, then a drop of 1.96% that would have been
the third, but it was over 2.5 ATR and the next 15 minutes took most of it back:

```text
  2026-10-15 02:00 UTC    0.58320   -0.56%     1/3  counts
  2026-10-15 02:15 UTC    0.58150   -0.29%     2/3  counts
  2026-10-15 02:30 UTC    0.57010   -1.96%     2/3  spike ignored
  2026-10-15 02:45 UTC    0.57820   +1.42%     0/3  against
```

The same token on chain: `add pros-pool pharos-pool:0x912c9aDe24D44d8922f0866D8Dcb079f1363f647 --base
0x52c48d4213107b20bc583832b0d951fb9ca8f0b0 --every-blocks 900` (the Faroswap WPROS/USDC 0.01% pool) read 0.56562
at 20:58 UTC; OKX's hourly candle closed at 0.5669 at 21:00.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/10-trendwatch/skill/trendwatch`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/10-trendwatch/skill/trendwatch -a claude-code
```

Then: "watch PROS and tell me if it falls three times in a row". No keys. Without the agent:

```bash
node .claude/skills/trendwatch/scripts/trendwatch.mjs add pros okx:PROS-USDT --bar 15m --n 3
```

```bash
node .claude/skills/trendwatch/scripts/trendwatch.mjs watch --every 60
```

Data lives in `%APPDATA%\trendwatch` on Windows, `~/.config/trendwatch` elsewhere, or `TRENDWATCH_HOME`.

## Commands

| Command | What it does |
|---|---|
| `add <name> <source> [options]` | start a watch; loads the history since `--since` (3 days by default) |
| `observe [name ...]` | one pass: new observations for every watch, new signals |
| `watch [--every SEC] [--count N]` | observe again and again |
| `history <name> [--last N \| --all]` | stored observations, how each counted, the signals |
| `signals [name]` | every signal and the observation that confirmed it |
| `set <name> k=v ...` | `n`, `direction`, `type`, `min_move_pct`, `timeframes`, `spike_atr`, `on_trigger` |
| `list`, `remove <name>` | the watches; remove one with its history |

Options for `add`: `--bar`, `--since`, `--rule consecutive|ema`, `--direction down|up`, `--n`, `--min-move`,
`--timeframes 1H,4H`, `--spike-atr`, `--on-trigger "<command>"` (runs once per new live signal with
`TRENDWATCH_WATCH`, `TRENDWATCH_AT`, `TRENDWATCH_CLOSE`, `TRENDWATCH_KEY`), and for a pool `--base`,
`--every-blocks`. Exit codes: 0 done, 1 error, 2 bad input, 3 another run holds the lock.

## Limits

- It signals; it doesn't trade. `--on-trigger` is the place to hook an alert or a next step.
- A pool's history costs a few Chain MCP calls per observation (about 4 s each at the MCP's 120 requests a
  minute), so load a long pool history with a large `--every-blocks`.
- Pool prices are mid prices from `slot0`, before the pool fee.

## How it's built

- [`src/sources.ts`](src/sources.ts): OKX candles (recent and paged history) and the Pharos pool reader.
- [`src/rules.ts`](src/rules.ts): EMA, ATR, the rules, the spike filter. Pure functions.
- [`src/store.ts`](src/store.ts): the per-watch folders, the keyed logs, the lock.
- [`src/cli.ts`](src/cli.ts): commands.
- [`skill/trendwatch`](skill/trendwatch): `SKILL.md` and the bundled `scripts/trendwatch.mjs` (`npm run build`).

## Tests

```bash
npm test -w 10-trendwatch
```

EMA and ATR, n below 3 refused, a trend firing once at the exact observation, direction and minimum move, a spike
that is ignored and one that holds, the EMA rule, a log that never stores a key twice and repairs a cut-off line,
the lock, a run that is "restarted" while observations keep coming (nothing lost, nothing twice, one signal, the
hook once), and the history output.
