---
name: dent
description: >
  dent: a Pharos yield optimizer. Compares where a wallet's USDC or PROS could earn (Avalon, OpenFi and Zona
  lending pools, the RockawayX USDC vault, Faroo stPROS liquid staking and Faroo vaults, or staying in the wallet)
  by the rate each place would pay once THIS amount lands in it, read from the pool's own interest-rate contract.
  Counts gas (estimated from the user's address), entry and exit fees, unbonding waits and pool cash, then says
  MOVE with the expected net gain and break-even, or STAY PUT with the reason. A MOVE becomes unsigned
  transactions on a local page where the user signs in their own browser wallet; the page re-checks every step
  against the live chain first. dent holds no key and sends nothing. Use when someone asks where to put their
  USDC or PROS on Pharos, whether to move funds, whether staking with Faroo is worth it, or to rebalance.
version: 1.0.0
requires:
  anyBins:
  - node
---

# dent

Run with Node 20+: `node scripts/dent.mjs <command>` (absolute path of `scripts/dent.mjs` from elsewhere). One
bundled file, no install, no keys. It reads Pharos mainnet through the public RPC (https://rpc.pharos.xyz),
`PHAROS_RPC_URL` overrides it.

## Commands

- `dent places`: the venues dent knows, per lane, with addresses.
- `dent look --wallet 0x... --lane USDC|PROS [--from <place>] [--amount N] [--hold-days 30] [--min-gain X]
  [--keep-pros 0.005] [--plan plan.json] [--json look.json]`: the comparison and the verdict. Takes 20-40 s
  (about 150 reads); say so before you run it. Without `--from` it moves from wherever the wallet holds the most
  in that lane; without `--amount`, all of it. `--hold-days` is how long the user means to leave the money; ask
  if they didn't say, it changes the answer. `--min-gain` is in lane units (USDC or PROS).
- `dent sign plan.json [--port 8642]`: serves the plan on http://127.0.0.1:8642/ for the user's browser wallet.
  Keep it running while they sign; stop it after.

## How to answer

1. Explain the table in plain words: what each place pays now, what it would pay with the user's money in it
   ("with you"), and what it really paid over the last 7 and 30 days. Where "with you" is far below "now",
   point it out: the pool is small and the user's own money would dilute it.
2. Give the verdict with its numbers: net gain over the hold, the parts it is made of (extra yield, fees, gas)
   and the break-even in days. For STAY PUT, give the reason line as dent printed it, in plain words.
3. Say how dent was careful: the place the money is now gets its best rate, a destination its worst one.
4. Closed places are part of the answer: say why each is closed (e.g. Faroo vaults revert InvalidPhase).
5. Use only numbers dent printed. Rates are simple annual rates from on-chain share prices or rate contracts,
   not promises.

## When the answer is MOVE

Write the plan (`--plan`), list the steps for the user, then start `dent sign plan.json` and tell them to open
the address in the browser that has their wallet, connect, and press each button in order. Before each signature
the page asks dent to re-check: before the first step it re-runs the whole comparison, and if the move stopped
paying the button stays disabled with the reason. Moves out of stPROS have a second phase: the claim opens about
a day after the redeem, so the user comes back and runs `dent sign` on the same plan again.

## Never

- Never sign, send, or ask for a private key, seed phrase or keystore. dent has no way to do any of it, and you
  don't either. The user signs in their own wallet.
- Never present a figure dent didn't print, and never round a STAY PUT into a MOVE.
