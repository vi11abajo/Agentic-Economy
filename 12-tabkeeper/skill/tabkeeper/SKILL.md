---
name: tabkeeper
description: >
  tabkeeper: pays for x402 APIs on Pharos mainnet with USDC, only for what the task needs, inside a spend budget
  and a per-call price cap. Reads each endpoint's price from its 402 answer before paying, refuses calls over the
  cap or over what is left of the budget (nothing is signed then), logs every payment with its price, what it
  bought, its tx hash and the running total, and retries a failed payment without ever paying twice. Comes with
  two live sellers: Harbor data (yields and open/closed state of the 16 Pharos Harbor assets, a wallet's Harbor
  positions and Morpho loan) and PROS market (Faroswap V3 pools and the Chainlink PROS/USD price). Use when a
  task needs paid data from an x402 endpoint, or the user asks to buy data or call a paid API on Pharos.
requires:
  anyBins:
  - node
---

# tabkeeper

Run with Node 20+ from this skill's folder: `node scripts/tabkeeper.mjs <command>` (use the absolute path of
`scripts/tabkeeper.mjs` when running from elsewhere). One bundled file, no install.

| Command | What it does |
|---|---|
| `task start "<the task>" [--budget N] [--cap N]` | opens a task: total budget and the most one call may cost, in USDC (default 0.01 and 0.005) |
| `catalog [seller-url]` | what the sellers offer, at what price (free) |
| `price <url>` | the price the endpoint asks and what for, and whether this task allows it. Pays nothing |
| `buy <url> --for "<why the task needs it>" [--max N]` | pays and prints the data, if the price fits the cap and what is left of the budget |
| `task` / `task end [--note "..."]` | where the task stands / closes it with every payment, refusal and the total |
| `log [--all]` | payments: time, price, running total, tx, what was bought |
| `retry [nonce or tx]` | settles payments in flight against the chain; resends one (the same payment, no new charge) |
| `wallet`, `config [set k=v]` | the paying address and balances; settings |

Sellers in the catalog by default: `https://mcp.pharosfdv.xyz/x402` (Harbor data and PROS market).

## How to use it

1. **Open a task first**, with the budget and cap the user gave (`--budget`, `--cap`), or the defaults if they
   gave none. Say them back to the user in one line.
2. Run `catalog`. For each thing the task might need, decide if it is worth its price **for this task**: buy
   only what you will actually use in the answer. Don't buy the same data twice in one task.
3. `buy <url> --for "<what the task needs it for>"`. Use `--max N` when the data is only worth N to this task.
   When the user asks for something, call `buy` even if you think it is over a limit: `buy` checks the cap and
   the budget first, refuses with nothing signed, and the refusal goes into the task's record. `price <url>` only
   looks and records nothing.
4. Paste each `buy` result's first lines (BOUGHT, price, tx link, task total) as is in a code block. Use the data
   below `--- data ---` for the answer; don't paste all of it. Never cut `buy`'s output (no `head`, `tail` or
   `grep` on it): what is cut was paid for, and getting it back takes a `retry`.
5. **REFUSED (exit 3)** means nothing was signed. Say why in one line (over the per-call cap, or the budget).
   Over the cap: go on without that data if you can, and say what is missing. **Budget reached: stop buying**,
   finish the answer with what you already bought and say what you couldn't get. Never raise the budget or the
   cap yourself, never start a new task to get around it; only the user can.
6. **FAILED (exit 4)**: the message says whether money moved (checked on chain). If it says the payment went
   through, run `retry <nonce>`: it resends the same payment, the seller answers it again, and nothing is
   charged twice. Don't `buy` the same URL again for that. The same goes when an answer that was paid for didn't
   reach the user: `retry <tx hash>` (the tx is on the BOUGHT line and in `log`; nonces are in `log --json`).
7. At the end run `task end` and paste its table: every payment with price, tx and running total, the refusals,
   and the total spent of the budget.

Payments are USDC on Pharos mainnet (eip155:1672), as EIP-3009 transfer authorizations: the wallet needs USDC and
no PROS (the seller's facilitator submits the transfer and pays the gas).

## The key

`buy` signs with `PRIVATE_KEY` from `.env` in the data folder (`--help` prints the folder), or the file named by
`TABKEEPER_ENV_FILE`. The user puts it there themselves. Never ask for a key, never read or print the .env, never
pass a key on a command line.

Settings (`config set k=v`): `default_budget` 0.01, `default_cap` 0.005, `max_attempts` 4, `timeout_s` 60,
`sellers` (comma-separated base URLs). Change them only when the user asks.
