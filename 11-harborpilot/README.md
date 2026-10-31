# 11 · Multi-Protocol Aggregator (SkillEngine · Hard)

**harborpilot** is an agent skill that puts every asset listed on [Pharos Harbor](https://port.pharos.xyz/harbor)
behind one interface: 16 assets from Morpho Vault V2, R25, Accountable, Ember, Centrifuge, Vishwa and BitFi. For
a deposit it checks all of them on Pharos mainnet at one block, picks the best one for your conditions, and says
why, and why not each of the others. It prepares the transactions, simulates them, and sends them from your
wallet. It can also borrow USDC against PROS on Morpho.

How it's built, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## What it checks, every time

For each venue, at the same block:

- **the yield it actually paid**: the share price now against 7 and 30 days ago, annualized. Not the target on
  the page;
- **whether it takes your deposit right now**: the deposit itself is simulated from your address. A pause, a
  minimum, a whitelist, KYB or a closed epoch shows up as the reason;
- **how the money comes back**: at once (and how much can leave now), after a lock, or as a request, and what
  that costs (a fee, a PROS fee on the request);
- TVL, minimums, and Harbor's own terms where the chain has none (redemption schedule, regions).

A venue that doesn't answer is marked down and the rest are compared without it.

## Real run (Pharos mainnet, 2026-10-31)

`venues`, all 16 at once:

```text
  venue                        protocol              TVL      7d     30d     exit  100 USDC deposit now
  prnh Raffaello NYLIM HYB     R25                 99.0K  37.33%  13.49%      1 d  OPEN
  vrpcs Axil Consumer Credit … R25                 9.91M  11.90%  11.91%    184 d  OPEN
  axilpot Axil Pot             R25                12.12M   8.96%   9.01%  T+0 req  OPEN
  vrpcw Axil Consumer Credit … R25                 2.19M   4.96%   4.96%      1 d  OPEN
  sharpbyte SharpByte USDC Ph… Morpho Vault V2     2.25M   7.64%   4.84%  at once  OPEN
  roxusdc RockawayX USDC       Morpho Vault V2    11.18M   4.99%   4.32%  at once  OPEN
  pgain Pelican pGAIN          Accountable         3.97M  34.43% -10.99%      7 d  OPEN
  apc3m Axil Prime 3M          R25                72.77M  12.89%  12.88%        -  closed: deposits are closed for the current epoch (#2): epochManager.isLocked() = true
  palpha Pharos RealFi Vault   Ember               4.01M  16.21%  12.69%        -  closed: the vault is paused: OperationPaused
  zsmb Zivoe SMB Credit        Centrifuge          1.00M   9.49%   8.90%        -  closed: members only (KYB): maxDeposit is 0 for this address
  tulprwa TulipaPRWA           Ember              519.30   0.00%   0.00%        -  closed: the vault is paused: OperationPaused
  gpci Goblin Private Credit … Ember              106.77   0.00%  43.81%        -  closed: the vault is paused: OperationPaused
  ethvp Vishwa ETHvp           Vishwa           10.8K tok       -       -        -  closed: on Pharos only a token its minter issues; no deposit contract here
  btcvc Vishwa BTCvc           Vishwa           568.52 tok       -       -        -  closed: on Pharos only a token its minter issues; no deposit contract here
  btcvp Vishwa BTCvp           Vishwa                  -       -       -        -  closed: no contract for it found on Pharos
  bfbtc BitFi bfBTC            BitFi            330.01 tok       -       -        -  closed: the Pharos contract has no underlying asset set (underlyingAsset() = 0x0), so nothing can be deposited here
```

`best 50 --exit-days 0` (I want to be able to take it out at once):

```text
  #  venue                             yield     net     exit       TVL
  1  axilpot Axil Pot                  8.96%   8.35%  T+0 req    12.12M
  2  sharpbyte SharpByte USDC Pharo…   4.84%   4.84%  at once     2.25M
  3  roxusdc RockawayX USDC            4.32%   4.32%  at once    11.18M

PICK  axilpot
  Axil Pot (APT) pays 8.96% a year, the lower of its realized yields (7d 8.96%, 30d 9.01%).
  Its 0.15% exit fee spread over 90 days leaves 8.35%.
  Exit: request redemption; the operator pays out (Harbor: Flexible, withdraw fee T+0 0.15%, T+7 0.10%).
  That is 3.52 points above the next one, SharpByte USDC Pharos Ecosystem (4.84%).

Left out:
  vrpcw      money comes back after 1 day(s), you want it within 0
  vrpcs      not taking this deposit now: below the vault's minimum deposit: BelowMinDeposit(50000000, 100000000)
  prnh       money comes back after 1 day(s), you want it within 0
  pgain      not taking this deposit now: below the vault's minimum deposit: InsufficientAmount
  ...
```

Why it ranks on the lower of the two windows: pGAIN shows 34% over 7 days and −11% over 30, pRNH 37% and
13%. One good week shouldn't beat a steady month.

A borrow, checked before anything is signed (each step on top of the previous one, against Morpho's real oracle):

```text
Morpho market USDC / WPROS (the one roxUSDC lends into): WPROS = 0.5375 USDC, liquidation at LTV 38.5%
  borrow rate 7.42% a year, 97,486.65 USDC free to borrow
  after this: 0.05 WPROS posted, 0.005 USDC owed, LTV 18.60%, liquidation if WPROS < 0.2597 USDC

Plan: post 0.05 PROS, borrow 0.005 USDC (from 0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb)
  1. OK     wrap 0.05 PROS into WPROS (sends 0.05 PROS)
  2. OK     approve 0.05 WPROS to Morpho
  3. OK     post 0.05 WPROS as collateral
  4. OK     borrow 0.005 USDC
```

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/11-harborpilot/skill/harborpilot`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/11-harborpilot/skill/harborpilot -a claude-code
```

Then: "where should I put 50 USDC on Pharos if I want to be able to take it out any time?". Reading and checking
need no key. To let it send, put `PRIVATE_KEY=...` into `.env` in its data folder (`--help` prints where). Without
the agent:

```bash
node .claude/skills/harborpilot/scripts/harborpilot.mjs best 50 --exit-days 0
```

Data lives in `%APPDATA%\harborpilot` on Windows, `~/.config/harborpilot` elsewhere, or `HARBORPILOT_HOME`.

## Commands

| Command | What it does |
|---|---|
| `venues [--amount N]` | all 16 assets: open for a deposit of N or why not, TVL, 7d / 30d yield, exit |
| `best <USDC> [conditions]` | the ranking, the pick and why, and why not each other venue |
| `positions [address]` | shares and value in every venue, open requests, the Morpho loan |
| `deposit <venue\|best> <USDC> [--yes]` | approve + deposit or deposit request |
| `withdraw <venue> <USDC\|all> [--yes]` | redeem at once or file the redemption request |
| `claim [venue] [--yes]` | claim filled requests |
| `borrow --pros N --usdc N [--yes]` / `repay [--yes]` | Morpho loan of USDC against PROS, and paying it back |
| `wallet`, `log`, `config [set k=v]` | address and balances, history, settings |

Conditions: `--exit-days N`, `--sync-only` (deposit filled at once), `--stable` (no venue whose share price fell
over 7 or 30 days), `--horizon D` (spreads an exit fee, default 90), `--region XX`.

Without `--yes` a command only simulates and shows the plan. With `--yes` each step is simulated again right
before it is signed, and the run stops at the first one that would fail. Exit codes: 0 ok, 1 error, 2 bad input
or no key, 3 blocked (nothing sent).

## Limits

- Deposits are in USDC: every Harbor asset that takes deposits on Pharos today takes USDC.
- Where a vault fills redemptions by hand (an operator), the time to get paid is Harbor's stated schedule, and
  the output says so.
- `max_usdc_per_deposit` is 100 and `max_ltv` 30% by default; `config set` changes them.

## How it's built

- [`src/venues.ts`](src/venues.ts): the 16 Harbor assets, their contracts and kinds.
- [`src/adapters.ts`](src/adapters.ts): quotes, positions and transactions per kind of vault.
- [`src/router.ts`](src/router.ts): the decision. Pure.
- [`src/morpho.ts`](src/morpho.ts): the USDC / WPROS Morpho market and the loan.
- [`src/exec.ts`](src/exec.ts): plan check and sending.
- [`src/chain.ts`](src/chain.ts): RPC, state overrides, revert decoding.
- [`skill/harborpilot`](skill/harborpilot): `SKILL.md` and the bundled `scripts/harborpilot.mjs` (`npm run build`).

## Tests

```bash
npm test -w 11-harborpilot
```

The ranking and every reason to leave a venue out, a venue that hangs and one that fails while the others answer,
revert decoding against selectors seen on chain, the state-override slots, the transactions per vault kind, the
plan check carrying each step's effect into the next, loan math, and the RPC retry on throttling.
