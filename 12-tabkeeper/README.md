# 12 · x402 Agent Buyer (Payments · Hard)

**tabkeeper** is an agent skill that pays for x402 APIs on Pharos mainnet, only for what the task needs. The
agent opens a task with a budget and a per-call cap, reads each endpoint's price from its 402 answer, buys what
is worth it, and closes the task with every payment listed. A call over the cap or over what is left of the
budget is refused before anything is signed. A failed payment is retried with the same signed payment, so it
can't be paid twice.

It comes with the other side too: two x402 sellers and their facilitator (Pharos has no public facilitator), live
at `https://mcp.pharosfdv.xyz/x402`.

How it's built, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## What's for sale

| Seller | Endpoint | Price | What you get |
|---|---|---|---|
| Harbor data | `GET /x402/harbor/yields?amount=N` | 0.002 USDC | the 16 Pharos Harbor assets read live: realized 7d / 30d yield, TVL, whether a deposit of N passes right now and why not, exit terms, the pick |
| Harbor data | `GET /x402/harbor/positions/:address` | 0.01 USDC | a wallet's holdings in every Harbor venue and its Morpho loan |
| PROS market | `GET /x402/pros/price` | 0.001 USDC | every Faroswap V3 WPROS / USDC pool and the Chainlink PROS / USD feed |

Paid in USDC on Pharos mainnet (`eip155:1672`) with x402 `exact` (EIP-3009 transfer authorization). The buyer
needs USDC and no PROS: the facilitator submits the transfer and pays the gas (about 0.001 PROS a payment).

## Real run (Pharos mainnet, 2026-11-01)

A task with a budget of 0.01 and a cap of 0.005 per call: two sellers bought from, the 0.01 endpoint refused
over the cap, and the first payment sent again to show it isn't charged twice:

```text
BOUGHT  PROS price for 0.001 USDC
  tx https://www.pharosscan.xyz/tx/0x223912b11d21a38045370ff68cb5f9711fe010ca987e81ab646cc1b11f24c409
  task "live check": spent 0.001 of 0.01 USDC, 0.009 left, cap 0.005 per call

BOUGHT  Harbor yields for 0.9 USDC for 0.002 USDC
  tx https://www.pharosscan.xyz/tx/0x0e2ae82659cd53ab1d53671a1983f2da191d0e8434c7d5ef61ab2815e4908fbb
  task "live check": spent 0.003 of 0.01 USDC, 0.007 left, cap 0.005 per call

REFUSED  my Harbor positions: price 0.01 USDC is over the per-call cap of 0.005 USDC. Nothing was signed.

$ tabkeeper retry 0x3a251b2059b2346db6a7ea84bf435334c7ecab36ed561beac045a8ef9b014159
BOUGHT  PROS price for 0.001 USDC (seller replayed the answer to an earlier send of this same payment)
  tx https://www.pharosscan.xyz/tx/0x223912b11d21a38045370ff68cb5f9711fe010ca987e81ab646cc1b11f24c409
  task "live check": spent 0.003 of 0.01 USDC, 0.007 left, cap 0.005 per call

Task closed: "live check"

  time         price     total  tx                 bought
  15:49:38     0.001     0.001  0x223912b1…24c409  PROS price
  15:50:20     0.002     0.003  0x0e2ae826…908fbb  Harbor yields for 0.9 USDC

Refused (nothing signed):
  15:50:35      0.01  http://localhost:4021/x402/harbor/positions/0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb: price 0.01 USDC is over the per-call cap of 0.005 USDC

Spent 0.003 of 0.01 USDC in 2 payments.
```

The same payment sent again got the same answer and the same tx, and the total didn't move. On chain the tx
shows one `AuthorizationUsed` for that nonce and one transfer of 0.001 USDC.

A task that runs out: budget 0.003.

```text
BOUGHT  Harbor yields for 50 USDC for 0.002 USDC
  tx https://www.pharosscan.xyz/tx/0x5d10732468bb5315a63705e6fadd9290f4260b9a66411371ba52ad63716ff834
BOUGHT  PROS price for 0.001 USDC
  tx https://www.pharosscan.xyz/tx/0x447a2d981e3df7ace404644cda04d26f2a97ed30cac37b12246a2d503b9c8ef8
  task "budget check": spent 0.003 of 0.003 USDC, 0 left, cap 0.005 per call
REFUSED  PROS price again: budget: 0.003 of 0.003 USDC spent, 0 left, this call costs 0.001. Nothing was signed.
Budget reached: stop buying for this task and finish with what you have.
```

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/12-tabkeeper/skill/tabkeeper`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/12-tabkeeper/skill/tabkeeper -a claude-code
```

Put `PRIVATE_KEY=...` of a wallet with a little USDC on Pharos into `.env` in its data folder (`--help` prints
where). Then: "with at most 0.01 USDC, find out where my USDC should go on Harbor and what PROS is worth".
Looking at prices and the catalog needs no key. Without the agent:

```bash
node .claude/skills/tabkeeper/scripts/tabkeeper.mjs catalog
```

Data lives in `%APPDATA%\tabkeeper` on Windows, `~/.config/tabkeeper` elsewhere, or `TABKEEPER_HOME`.

## Commands

| Command | What it does |
|---|---|
| `task start "<task>" [--budget N] [--cap N]` | opens a task (default budget 0.01, cap 0.005 USDC) |
| `catalog [seller-url]` | what the sellers offer and at what price (free) |
| `price <url>` | the price from the endpoint's 402, and whether this task allows it. Pays nothing |
| `buy <url> [--for "..."] [--max N]` | pays and prints the data, if the price fits |
| `task`, `task end [--note]` | where the task stands; close it with every payment and refusal |
| `log [--all] [--json]` | time, price, running total, tx, what was bought |
| `retry [nonce or tx]` | settles payments in flight against the chain; resends one, same payment |
| `wallet`, `config [set k=v]` | address and balances, settings |

Exit codes: 0 ok, 1 error, 2 bad input or no key, 3 refused (nothing signed), 4 payment failed.

## Running the sellers

```bash
SELLER_PRIVATE_KEY=0x... PORT=4021 node 12-tabkeeper/dist/seller/server.js
```

The seller's key receives the USDC and pays the settlement gas, so it needs a little PROS. `/x402/health` and
`/x402/catalog` are free; the facilitator is at `/x402/facilitator/{verify,settle,supported}`. Docker and nginx
files are in [`deploy/`](deploy).

## Limits

- Only x402 `exact` in USDC on Pharos mainnet is bought. A 402 that asks for another network or token is refused
  with the reason.
- Money in a payment that was signed but not settled counts against the budget until the chain shows it
  (counted) or its authorization expires unused (120 s, then it is released).
- The seller's replay of a paid answer lasts as long as its data folder: 5000 answers are kept.

## How it's built

- [`src/buyer.ts`](src/buyer.ts): one purchase, the retries, reconciling with the chain.
- [`src/ledger.ts`](src/ledger.ts): the journal, totals, the cap and budget check. Pure.
- [`src/wallet.ts`](src/wallet.ts): chain reads (`authorizationState`, `AuthorizationUsed`) and signing.
- [`src/cli.ts`](src/cli.ts): the commands.
- [`src/seller/`](src/seller): the two sellers, the facilitator, the replay of paid answers.
- [`skill/tabkeeper`](skill/tabkeeper): `SKILL.md` and the bundled `scripts/tabkeeper.mjs` (`npm run build`).

## Tests

```bash
npm test -w 12-tabkeeper
```

The cap, the budget and held money, counting a payment once, two endpoints in one task, refusals that sign
nothing, a lost answer, a 500 and a dropped request retried with the same nonce, a payment that only the chain
shows, a hold released after expiry, a rejected payment not resent, and the seller's replay of a paid answer.
