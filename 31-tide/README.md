# 31 · Gas Fee Optimizer

**tide** watches gas on Pharos, holds a transaction that isn't urgent until gas is cheap, sends it before its
deadline no matter what, and then shows what you paid next to what you would have paid.

```bash
cd 31-tide && npm ci && npm run build && npm test
node skill/tide/scripts/tide.mjs now
node skill/tide/scripts/tide.mjs history --hours 24
node skill/tide/scripts/tide.mjs send --to 0x… --value 0.001 --deadline 20m --dry-run --from 0x…
node skill/tide/scripts/tide.mjs send --to 0x… --value 0.001 --deadline 20m --key-env <path to .env with PRIVATE_KEY>
```

Mainnet by default, `--network atlantic` for the testnet.

## What gas looks like on Pharos

Measured on 2026-11-14, before writing any of this:

| | mainnet | Atlantic |
|---|---|---|
| base fee | 10 gwei at all 169 hourly samples of the week before | 1 gwei over the last 1024 blocks |
| `eth_gasPrice` | 10 gwei | 10 gwei |
| `eth_maxPriorityFeePerGas` | 0 | 0 |
| blocks | about 0.84 s, gas used under 0.1% of the limit | about 1.94 s, under 0.3% |
| what 40 recent txs paid (`effectiveGasPrice`) | 31 at 10, 9 at 10.06 to 12 | 32 at 1, 8 at 10 |

So the base fee hardly moves, and blocks are nearly empty. The money goes where people overpay: a tip nobody needs
to outbid, or a legacy price taken from `eth_gasPrice`. On Atlantic that is 10 gwei on a 1 gwei base fee, ten times
the price. tide does both halves of the job: it waits for a base fee under the line when there is something to wait
for, and it never bids more than the cheapest txs that got in lately.

## Tracking

- `now`: base fee of the latest block, `eth_gasPrice`, the tips paid in the last 20 blocks with txs, and the real
  `effectiveGasPrice` of the last 30 txs, with how many paid above the base fee.
- `history --hours N`: the base fee at 49 blocks spread evenly over N hours (a day costs 49 reads, not 100k), as a
  sparkline, min, median, max and a few rows, plus tide's own readings.
- `watch --every 15`: keeps taking readings. Every reading tide takes, here or while holding, goes to
  `samples.jsonl` in tide's folder (`TIDE_HOME`, or `%APPDATA%\tide` / `~/.config/tide`).

## Holding a tx

`send` takes the tx (`--to`, `--value`, `--data`), a `--deadline` (`20m`, `2h`, or an ISO time) and an optional
`--max-gwei` line. Without a line, the line is the lowest base fee in the history (`--hours`, 24 by default).

Every 5 seconds it reads the gas again:
- base fee at or under the line: send now;
- over the line, but 30 seconds or less to the deadline: send anyway, with a cap of 3× the base fee so a jump in
  the next blocks can't leave it behind;
- otherwise keep holding, with a line in the log when the base fee changes and once a minute.

The fees are EIP-1559: tip = the low end of what the last blocks' cheapest txs paid (0 on both networks that day),
cap = 2× base fee + tip. You pay base + tip, the cap only limits it. Gas limit = `eth_estimateGas` + 20%.

The job is written to `jobs.json` after every check and after the send. If tide is stopped, `resume` carries on: a
job still holding goes back to holding (and goes at once if its deadline is close), a job already sent only waits
for its receipt and is never sent twice.

## The receipt

```
mined in block …: <tx link>
  held … over … checks, sent … before the deadline
  why then: …
  paid … gwei per gas × … gas = … PROS
  if sent right at request time (base + tip then): …  (the same | you saved … | you paid … more)
  at eth_gasPrice at request time (what most wallets offer): …
  the median recent tx paid (30 txs): …
```

"Paid" is the receipt's `effectiveGasPrice` and `gasUsed`. Each line under it is the same gas at another price.

## Live runs

A real send on 2026-11-14, done by an agent with the skill installed from this repo: 0.001 PROS from
`0x4644…D3Bb` back to itself, `--deadline 3m --max-gwei 9`. The base fee was 10 gwei at every check, so the line was
never reached and the deadline decided:

```
[19:53:23] holding: base fee 10 gwei is over the line (9 gwei), 2 min 51 s to the deadline (block 23053600)
[19:54:30] holding: base fee 10 gwei is over the line (9 gwei), 1 min 43 s to the deadline (block 23053677)
[19:55:41] holding: base fee 10 gwei is over the line (9 gwei), 33 s to the deadline (block 23053755)
[19:55:48] sent 0x867f8842441b9bb332b12dcdfcdfe8f193e7e1ad5537f0e0f9d852c93ad5a6f6 (deadline in 27 s and base fee still 10 gwei (line 9): sending anyway)

mined in block 23053766: https://www.pharosscan.xyz/tx/0x867f8842441b9bb332b12dcdfcdfe8f193e7e1ad5537f0e0f9d852c93ad5a6f6
  held 2 min 30 s over 25 checks, sent 26 s before the deadline
  why then: deadline in 27 s and base fee still 10 gwei (line 9): sending anyway
  paid 10 gwei per gas × 21000 gas = 0.00021000 PROS
  if sent right at request time (base + tip then): 10 gwei = 0.00021000 PROS  (the same)
  at eth_gasPrice at request time (what most wallets offer): 10 gwei = 0.00021000 PROS  (the same)
  the median recent tx paid (30 txs): 10 gwei = 0.00021000 PROS  (the same)
```

Read back from the RPC: a type 2 tx with `maxPriorityFeePerGas` 0 and `maxFeePerGas` 30 gwei (the 3× cap of a
forced send), receipt status 1, `gasUsed` 21000, `effectiveGasPrice` 10 gwei. "The same" is the honest result on a
day when the base fee didn't move; the agent said so instead of claiming a saving.

Dry runs on 2026-11-14 from `0x4644…D3Bb` to `0xa991…4348`, nothing sent:

- **mainnet, `--max-gwei 9 --deadline 50s`.** The base fee stayed at 10 gwei, over the line, so tide held. It went
  24 s before the deadline: "deadline in 24 s and base fee still 10 gwei (line 9): sending anyway". Gas estimate
  21000, so 0.00021 PROS, the same at every comparison price.
- **Atlantic, `--deadline 10m`, no line.** The line from history was 1 gwei and the base fee was 1 gwei, so it would
  send at once. 0.000021 PROS, against 0.00021 PROS at `eth_gasPrice`: 90% less.

## Layout

`src/net.ts` the two networks · `src/gas.ts` readings, history, what txs paid · `src/hold.ts` the rule, the fees,
the comparison · `src/run.ts` the loop around one job · `src/store.ts` jobs and readings on disk ·
`src/keys.ts` the key from an env file · `src/cli.ts` · `skill/tide/` SKILL.md plus one bundled script.
