---
name: tide
description: >
  Gas timing on Pharos mainnet and Atlantic. Shows gas now and over time (base fee, eth_gasPrice, tips, what recent
  txs really paid), holds a non-urgent transaction until the base fee is at or under a line (yours, or the lowest
  in recent history), always sends it before the deadline, and prints the receipt next to what it would have cost
  at request time, at eth_gasPrice and at what other txs paid. Keeps jobs across restarts. Use when someone wants
  to send a tx cheaply by a deadline, or asks what gas costs on Pharos.
version: 2.0.0
requires:
  anyBins:
  - node
---

# tide

One bundled script, Node 20+: `node scripts/tide.mjs <command>`. Add `--network atlantic` for the testnet.

## Looking at gas

- `node scripts/tide.mjs now`: base fee, eth_gasPrice, the tips txs paid in the last blocks, and the real
  effectiveGasPrice of the last 30 txs (how many paid above the base fee).
- `node scripts/tide.mjs history --hours 24`: the base fee at 49 blocks spread over that time, a sparkline, min,
  median, max, and tide's own readings if it has any. `watch --every 15` keeps adding readings.

Say what the numbers say. On 2026-11-14 the mainnet base fee had been 10 gwei at every hourly sample for a week:
if it is flat, say so, and say that the saving then comes from not overpaying (tip, or eth_gasPrice above base).

## Sending

1. Ask for: recipient, amount (or calldata), the deadline, and optionally a gwei line. Ask where the key is: an
   env file with `PRIVATE_KEY`. Never ask for the key itself, never print or read the file.
2. First a dry run, no key needed:
   `node scripts/tide.mjs send --to <addr> --value <PROS> --deadline 45s [--max-gwei <n>] --dry-run --from <their address>`
   A dry run holds exactly like the real thing, so over the line it waits until near its deadline. Give it a short
   one (45s is plenty to see the gas estimate, the fees and which way it goes) and keep the person's own deadline
   for the real send.
3. When they say go, the same with `--key-env <file>` instead of `--dry-run --from`. tide holds, prints a line when
   the base fee changes, sends, waits for the receipt.
4. If tide was stopped while holding: `node scripts/tide.mjs resume --key-env <file>`. `jobs` lists everything.

## Retelling the receipt

Block and tx link, how long it held, why it went when it did (under the line, or the deadline), what it paid per
gas and in PROS, then each comparison line as printed: at request time, at eth_gasPrice, at the median recent tx.
"the same" is a fine answer. A send after the deadline is printed as AFTER: say it plainly.
