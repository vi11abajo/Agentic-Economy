---
name: trendwatch
description: >
  trendwatch: a skill with memory that watches a price over time and signals only once a trend holds for
  several observations in a row, never on one noisy reading. Sources: any OKX instrument (public candles, no
  key) or a V3 pool on Pharos (read through the Pharos Chain MCP, block by block). Every observation is kept on
  disk, so a restart loses nothing and duplicates nothing, and the history shows the exact moment a trend was
  confirmed. Use when the user wants to watch a token (PROS, BTC, anything on OKX or in a Pharos pool), be told
  when it keeps falling or rising, or see what was observed so far.
requires:
  anyBins:
  - node
---

# trendwatch

Run with Node 20+ from this skill's folder: `node scripts/trendwatch.mjs <command>` (use the absolute path of
`scripts/trendwatch.mjs` when running from elsewhere). One bundled file, no install, no keys.

| Command | What it does |
|---|---|
| `add <name> <source> [options]` | starts a watch and loads its history since `--since` at once |
| `observe [name ...]` | one pass over every watch: stores the new observations, reports new signals |
| `watch [--every SEC] [--count N]` | `observe` again and again |
| `history <name> [--last N \| --all]` | the stored observations, how each one counted, and every signal |
| `signals [name]` | every signal with the observation that confirmed it |
| `set <name> k=v ...` | change the rule: `n`, `direction`, `type`, `min_move_pct`, `timeframes`, `spike_atr`, `on_trigger` |
| `list`, `remove <name>` | the watches; remove one with its history |

Sources: `okx:<instId>` (`okx:PROS-USDT`, `okx:BTC-USDT`, `okx:ETH-USDT-SWAP`, ...; `--bar` is one observation per
candle: 1m 5m 15m 30m 1H 4H 1D) or `pharos-pool:<pool address> --base <token address> --every-blocks N` (about one
block a second on Pharos, so 900 is about 15 minutes).

Rules (`--rule`):

- `consecutive` (default): `--n` closes in a row moving in `--direction` (down/up), and at least `--min-move` % in
  total if set.
- `ema`: the close below a falling EMA30 (or above a rising one for `up`) on every timeframe in `--timeframes`
  (e.g. `1H,4H`), `--n` observations in a row.

`--n` is at least 3. A single move bigger than `--spike-atr` ATRs (default 2.5) waits for the next observation: if
most of it comes back, it counts for nothing. A trend fires once, then the streak has to break before it can fire
again. `--on-trigger "<command>"` runs a command once per new live signal, with `TRENDWATCH_WATCH`,
`TRENDWATCH_AT`, `TRENDWATCH_CLOSE` and `TRENDWATCH_KEY` set.

## How to use it

1. Turn what the user asks into a watch: "tell me if PROS keeps falling" is
   `add pros okx:PROS-USDT --bar 15m --direction down --n 3`. Pick a short name. If they say how many times or
   how much, put it in `--n` and `--min-move`. Never go below 3.
2. After `add` (or `observe`), paste the output as is. When asked what was seen, run `history` and paste it: it
   shows each observation, the streak, spikes that were ignored, and `<== TREND CONFIRMED` where it fired.
3. Explain a signal in plain words: when it was confirmed, at what price, after how many observations. Signals
   "found in the loaded history" come from data loaded just now (a new watch, or after a long stop), not fresh
   ones; `SIGNAL` lines are fresh.
4. To keep watching, run `watch` (or `observe` on a schedule). In a chat, give `watch` a `--count` (e.g.
   `--every 60 --count 5` for "a few minutes") so it ends and you can report back. Restarting is safe: the next run
   loads what it missed and nothing is stored twice.
5. Don't change the rule on your own; change it with `set` only when the user asks.
