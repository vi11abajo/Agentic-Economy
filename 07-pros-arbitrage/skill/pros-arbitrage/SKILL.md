---
name: pros-arbitrage
description: >
  prosArbitrage: scans the PROS price on Faroswap V3 (Pharos mainnet, PROS/USDC) and on the OKX, Bitget and
  MEXC spot books (PROS/USDT) in one go, nets out pool fees, exchange taker fees, slippage, gas and the PROS
  withdrawal needed to rebalance, and only acts when a route still pays above the user's threshold. Acting is
  simulated: the DEX leg is a real swap run inside eth_call, the CEX leg an order payload. Nothing is sent and no
  keys are needed. Use when the user asks whether there's a PROS arbitrage right now, wants to watch for one, or
  wants to change the threshold, sizes or fees.
requires:
  anyBins:
  - node
---

# prosArbitrage

Run with Node 20+ from this skill's folder: `node scripts/prosarb.mjs <command>` (use the absolute path of
`scripts/prosarb.mjs` when running from elsewhere). One bundled file, no install, no keys.

| Command | What it does |
|---|---|
| `scan [--size USD] [--top N]` | one scan: every source, every route at every size, and the decision |
| `watch [--every SEC] [--count N] [--full]` | scan again and again (default every 60 s): one line per scan, the whole scan for an ACT (or every scan with `--full`), and a summary at the end |
| `config`, `config set k=v ...` | `min_net_usd`, `min_net_pct`, `sizes_usd=50,200,1000`, `rebalance=on/off`, `okx.taker_pct`, `bitget.withdraw_pros`, ... |
| `log [--last N]` | the last scans from the log, with their decisions |

## What a scan does

- **Sources, all read in the same scan**: the Faroswap V3 PROS/USDC pools on Pharos (a pool with less than
  `min_pool_usdc` is left out), the OKX, Bitget and MEXC PROS/USDT books, and Chainlink PROS/USD, USDC/USD and
  USDT/USD on Pharos as the reference. A source more than `max_oracle_gap_pct` off Chainlink is treated as bad
  data for that scan.
- **Routes**: buy on one venue and sell the same PROS on another, DEX against each exchange and exchange against
  exchange, both directions, at every size in `sizes_usd`.
- **Costs per route**: pool fee, exchange taker fee, slippage (the real pool swap and the real book depth for that
  size), gas (the simulated swap's own gas plus `dex_overhead_gas`, at the live base fee, in USD via Chainlink),
  and the rebalance (the PROS withdrawal fee from the exchange you bought on). Net = gross - all of them.
- **Decision**: ACT if the best route's net is at least `min_net_usd` and `min_net_pct`, otherwise SKIP with the
  numbers. Every scan goes to `scans.jsonl` in the data folder.

## How to talk about it

1. Run `scan` (or `scan --size N` if the user names a size) and paste the output as is in a code block.
   For `watch`, paste its lines as they are too; never retype a scan from memory.
2. Explain the decision in plain words: which route was best, how big the gross spread was, which cost ate it.
   For a SKIP, say what would have to change (a wider spread, a bigger or smaller size, cheaper fees).
3. For an ACT, say clearly that nothing was sent: the DEX swap was simulated on the live pool and the exchange
   order is only a payload. Show the two prepared legs.
4. Fees are a regular user's (OKX spot group 1 base tier, Bitget and MEXC public rates, checked 2026-10-24). If the
   user has a VIP tier, change it with `config set okx.taker_pct=...`. Never change thresholds on your own.
5. The routes assume inventory on both sides (USDC and PROS in a wallet, USDT and PROS on the exchanges). Moving
   USDT back is not priced in; say so if the user asks about running it for real.
