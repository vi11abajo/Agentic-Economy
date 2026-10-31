---
name: harborpilot
description: >
  harborpilot: all 16 Pharos Harbor assets (port.pharos.xyz/harbor) behind one interface: Morpho Vault V2
  (roxUSDC, SharpByte), R25 (VRPC 1D and 6M, Axil Pot, pRNH, APC3M), Accountable pGAIN, Ember (pALPHA, tulPRWA,
  GPCI), Centrifuge zSMB, Vishwa, BitFi. Checks every venue on Pharos mainnet at one block (realized yield over 7
  and 30 days, TVL, whether a deposit of this size goes through right now, how and when money comes back), picks
  the best one for the user's conditions and says why, and why not each of the others. Prepares, simulates and
  sends deposits, withdrawals and claims, and a Morpho loan of USDC against PROS. Use when the user wants to put
  USDC to work on Pharos, compare Harbor vaults or yields, see their positions, take money out, or borrow
  against PROS.
requires:
  anyBins:
  - node
---

# harborpilot

Run with Node 20+ from this skill's folder: `node scripts/harborpilot.mjs <command>` (use the absolute path of
`scripts/harborpilot.mjs` when running from elsewhere). One bundled file, no install. A full check of all 16
venues takes about 10 seconds (the public RPC is rate-limited, so requests are paced).

| Command | What it does |
|---|---|
| `venues [--amount N]` | every Harbor asset: OPEN (a deposit of N USDC passes in simulation now) or closed and why, TVL, yield 7d / 30d, exit |
| `best <USDC> [conditions]` | ranks the venues that fit, picks one, explains it, and lists why each other one was left out |
| `positions [address]` | shares and their USDC value in every venue, open requests, the Morpho loan |
| `deposit <venue\|best> <USDC> [conditions] [--yes]` | approve + deposit (or deposit request) |
| `withdraw <venue> <USDC\|all> [--yes]` | redeem at once, or file the redemption request |
| `claim [venue] [--yes]` | claim deposit / redemption requests the vault has filled |
| `borrow --pros <N> --usdc <N> [--yes]` | wrap PROS, post it as collateral on Morpho (USDC / WPROS market), borrow USDC |
| `repay [--yes]` | repay the whole loan, take the collateral back, unwrap it to PROS |
| `wallet`, `log`, `config [set k=v]` | the signer's address and balances, past plans and sends, settings |

Conditions (for `best` and `deposit best`), taken from what the user says:

- `--exit-days N`: "I need it back within N days" (`0` = at once)
- `--sync-only`: the deposit must be filled at once, not as a request
- `--stable`: no venue whose share price fell over the last 7 or 30 days
- `--horizon D`: how long the money stays (spreads a one-off exit fee); default 90
- `--region XX`: skip venues Harbor marks as not for that country

## How to use it

1. To compare or pick, run `best <amount>` with the conditions the user gave. Paste the output as is in a code
   block. Then say in plain words which venue it picked, why (the yield it is ranked on, the exit), and the main
   reasons the others were left out. The yield used is the lower of the 7-day and 30-day realized yield; say so
   if the user asks why a venue's advertised APY is higher.
2. For an action, run the command **without** `--yes` first. It simulates every step on the current chain state
   (each step on top of the previous one) and prints OK or FAILS with the reason. Paste it.
3. If a step FAILS (exit 3): explain the reason. Don't work around it: don't change the venue, the amount or the
   limits on your own.
4. If every step passes: tell the user what will be signed (each step) and send it with the same command plus
   `--yes`, unless the user asked to review it first. `--yes` simulates each step again right before signing it
   and stops at the first one that would fail. Paste the result with the explorer links.
5. After a deposit or withdrawal, run `positions` to show the new state.
6. For a loan, `borrow` prints the price, LTV after the loan and the liquidation price. Make sure the user sees
   the liquidation price before sending. It refuses a loan above `max_ltv` (30%; the market liquidates at
   38.5%).

A venue that doesn't answer is reported as DOWN with the reason; the others are compared without it. Mention it.

## The key

`--yes` signs with `PRIVATE_KEY` (or `MNEMONIC`) from `.env` in the data folder (`--help` prints the folder), or
the file named by `HARBORPILOT_ENV_FILE`. The user puts it there themselves. Never ask for a key, never read or
print the .env, never pass a key on a command line. Without a key, `--from <address>` checks a plan for any
address.

Settings (`config set k=v`): `max_usdc_per_deposit` 100, `max_ltv` 0.3, `gas_buffer_pct` 20,
`venue_timeout_ms` 25000. Change them only when the user asks.
