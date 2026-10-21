---
name: trenchscope
description: >
  On-chain checks for Prosper (pros-per.xyz) bonding-curve tokens on Pharos mainnet, before buying and while holding.
  Use when the user wants to ape into a Prosper / pToken / Pharos memecoin, asks whether a token is safe or too late to
  buy, wants to know if they should sell or take profit on a Prosper bag, or wants to set or change their buy/sell
  thresholds. Reads FDV, real holders, the biggest outside bag, time left, curve progress, and the user's own bag from
  chain, prints a decision trace, and only trades when every rule says so and the user said yes.
requires:
  anyBins:
  - node
---

# trenchscope

Looks at a Prosper curve token through a periscope before the user climbs out of the trench. Every run reads the
market fresh from Pharos mainnet (and the token's holder list from the Pharos explorer), checks it against the
user's own thresholds and prints a trace: each check, its value, the limit, pass/fail, and the verdict.

- **Buy check**: APE only if every buy check passes, otherwise NOPE.
- **Sell check**: EXIT as soon as any sell rule fires, otherwise HOLD.
- **Advice** (price impact on buy, slippage on sell) never blocks. When it flags, you ask the user before trading.

Run it with Node 20+ from this skill's folder (no install needed, it is one bundled file):

```bash
node scripts/trenchscope.mjs <command>
```

Use the absolute path of this skill's `scripts/trenchscope.mjs` if you run it from somewhere else.

| Command | What it does |
|---|---|
| `setup` | Lists every threshold with what it means and a suggested value, plus wallet/key status |
| `config` / `config set k=v ...` | Shows / changes thresholds (`10k`, `5%`, `48h`, `2d`, `off` all work) |
| `buy <market or token> <PROS>` | Buy check for that size |
| `sell <market or token>` | Sell check for the user's bag (needs their public wallet address) |
| `track <market or token> [--cost <PROS>]` | Start watching a bag the user bought by hand |
| `positions`, `log` | Known bags, last runs |

Add `--execute` to trade (only with a key, see below), `--approve` after the user accepted flagged advice,
`--json` for machine-readable output. Exit codes: 0 done (any verdict), 1 error, 2 needs setup or bad input,
3 needs the user's approval.

## First run: ask for the thresholds

Nothing is hard-coded. Before the first check (or when a command exits with code 2 and "No thresholds yet"):

1. Run `setup` and go through it with the user. For each key, say in one line what it does and offer the
   suggestion. Ask everything in one message, grouped as Buy / Sell / General, not one question per turn.
2. Ask for their **public** wallet address. Sell checks need it (to read their bag and their entry price).
   Buy checks work without it.
3. Save their answers in one go: `config set wallet=0x... max_fdv_usd=10k min_holders=5 ...`
4. Show the saved values and, every time you save them, end with this line in your own words: **they can change
   any threshold at any time, just ask** (for example "raise max FDV to 20k" or "turn off the progress check").
   Then run `config set` with only that key.
5. If they gave a wallet later than the first check, mention that earlier checks counted their own bag as a
   holder (from now on it is left out).

At least 3 buy checks and 3 sell rules must be on (take profit and stop loss count as one). If the user turns
too many off, the command says so; tell them which ones are still on.

## Buying

1. Run `buy <address> <size>` and paste the trace for the user in a code block, as is. Don't round or restate
   the numbers from memory.
2. **NOPE**: explain the failed checks in plain words (for example "one wallet holds 9.2% of the supply, your
   limit is 5%"). No trade, and don't offer a way around it. If they want, they can change the threshold.
3. **APE without advice flags**: say all checks passed and ask if they want to buy.
4. **APE with an advice flag**: ask directly, with the number, e.g. "All checks pass, but buying 4 PROS moves
   the price 6.1% (your advice limit is 3%). Buy anyway, or buy less?"
5. Only after a clear yes: run the same command with `--execute` (and `--approve` if advice was flagged).
   It re-checks everything right before sending, so the verdict can still change to NOPE. Then share the tx
   link it prints.

## Selling

1. Run `sell <address>`. On the first check of a bag bought by hand it finds the entry price from the user's
   own Prosper trades. If none are found, P&L shows n/a: ask the user what they paid and run
   `track <address> --cost <PROS>`.
2. **HOLD**: show the trace, nothing to do.
3. **EXIT**: say which rule fired and ask if they want to sell. With a slippage flag, include it in the
   question ("selling the whole bag loses 7.4% to the curve, your limit is 5%").
4. After a clear yes: `sell <address> --execute` (plus `--approve` for flagged slippage).

## Key and wallet: optional, and never in the chat

- Without a key trenchscope only advises. When the verdict says act, tell the user they can do it themselves on
  Prosper (the trace prints the market and size), for example "checks passed, you can buy, but I don't have a
  wallet to do it".
- If the user wants trenchscope to trade, they add `PRIVATE_KEY=0x...` (or `MNEMONIC="..."`) to the `.env` file
  in the trenchscope data folder that `setup` prints. **They do this themselves.**
- **Never ask for a private key or seed phrase in the chat**, and never write one into a command. If the user
  pastes one anyway, don't use it: tell them it is now exposed in the chat history and they should move funds
  to a fresh wallet.
- Never add `--execute` or `--approve` on your own. Each trade needs the user's yes in the chat for that trade.

## What the checks read

| Check | Source |
|---|---|
| FDV | market `quoteBuy` x total supply x Chainlink PROS/USD on Pharos (stale feed = can't check) |
| holders, top holder, whale, holder exodus | holder list from the Pharos explorer; Prosper's own wallets are found in the token's creation transaction and left out, so are the user and dust bags |
| time left | market `endsAt()` vs the latest block |
| progress | WPROS held by the curve vs its 20,000 PROS graduation target |
| price impact, slippage | `quoteBuy` / `quoteSell` on the user's size |
| P&L, liquidity drain | `quoteSell` on the bag and the curve's PROS vs the snapshot taken at entry |

If a source can't be read, that check doesn't pass (buy says NOPE) and that rule doesn't fire (sell stays HOLD):
missing data never leads to a trade. Every run is appended to `runs.jsonl` in the data folder.
