# 07 · Arbitrage Scanner (SkillEngine · Hard)

**prosArbitrage** is an agent skill that looks for PROS arbitrage between Faroswap on Pharos and three exchanges.
One scan reads the PROS/USDC pools on Faroswap V3 and the PROS/USDT spot books on OKX, Bitget and MEXC at the
same moment, prices every route (DEX against each exchange, and exchange against exchange) with every cost in
it, and only acts when a route still pays after all of them. Acting is simulated: nothing is sent and it needs
no keys.

## Sources in one scan

| Source | What is read | How |
|---|---|---|
| Faroswap V3 PROS/USDC, fee tiers 0.01%, 0.05%, 0.3%, 1% | mid price, reserves, and the exact output of a swap of each size | pools found through the Faroswap V3 factory on Pharos; swaps run on the live pool inside `eth_call` (below) |
| OKX, Bitget, MEXC PROS/USDT | the order book, 100+ levels | public market APIs, no keys |
| Chainlink on Pharos | PROS/USD, USDC/USD, USDT/USD | `latestRoundData()`; USDC and USDT are converted to USD with them, and every source is compared with PROS/USD |

A pool with less than `min_pool_usdc` (1,000 by default) is left out: the 1% pool holds about 58 USDC. A source
more than `max_oracle_gap_pct` (5%) off Chainlink is treated as bad data for that scan. Both are said in the
output.

## Exact DEX quotes without a quoter

Faroswap has no V3 quoter on Pharos (its app quotes through an aggregator API), so I wrote a small contract,
[`contracts/SwapSimulator.sol`](contracts/SwapSimulator.sol), that is never deployed. For each quote the scanner
puts its code at a throwaway address with an `eth_call` state override, gives that address the input tokens the
same way (WPROS balances sit in storage slot 3, USDC in slot 9; I checked both against `balanceOf`), and calls the
real pool's `swap`. What comes back is exactly what the pool would pay right now, fee and price impact included,
plus the gas the swap used. The same call is the "simulated execution" of the DEX leg.

## Costs

For each route at each size (`sizes_usd`, 50 / 200 / 1,000 by default):

- **Fees**: the pool's fee tier, and the exchange's taker fee for a regular user:

  | Exchange | Spot maker / taker | PROS withdrawal to Pharos | Source (checked 2026-10-24) |
  |---|---|---|---|
  | OKX | 0.08% / 0.10% | 0.00027 PROS | OKX fee pages, spot group 1, base tier (PROS-USDT is category 1) |
  | Bitget | 0.10% / 0.10% | 0.149 PROS | public symbol and coin APIs |
  | MEXC | 0% / 0.08% | 0.2 PROS | public symbol API, MEXC fee page |

- **Slippage**: the real pool swap for that size, and the real book depth walked level by level.
- **Gas**: the simulated swap's gas plus `dex_overhead_gas` (61,000 by default: transaction base cost, token
  transfers, a router), at the live base fee (a flat 10 gwei on Pharos), in USD via Chainlink. About $0.001.
- **Rebalance**: the PROS bought on one side has to get to the other side. When the buy is on an exchange, that's
  its PROS withdrawal fee; deposits are free by default. Exchange against exchange, this is what usually decides
  it: Bitget's 0.149 PROS is $0.10 on every trade. `rebalance=off` leaves it out.

Net = what the sale brings - what the buy cost - gas - rebalance. In the log the gross spread (top of book,
before fees) minus fees, slippage, gas and rebalance always adds up to the net.

## Decision

ACT when the best fillable route's net is at least `min_net_usd` ($1) and `min_net_pct` (0.1%), otherwise SKIP
with the numbers and the threshold it missed. A route a book can't fill is never chosen.

On ACT the two legs are prepared and nothing is sent:

- DEX: the swap (pool, token in, amount, expected out from the simulation, a 0.5% worse minimum out), already run
  on the live pool inside `eth_call`;
- exchange: a limit order payload (symbol, side, size, price: the deepest level touched, 0.5% worse), with no API
  keys involved.

Every scan, ACT or SKIP, is appended to `scans.jsonl` in the data folder with every source price, every route's
gross spread, each cost, the net and the decision.

## A real scan

```text
prosArbitrage · scan · block 21,069,376 · 2026-10-23 23:43:10 UTC
oracles (Chainlink on Pharos, 22 min old): PROS 0.66850 · USDC 0.99986 · USDT 0.99873 · gas 10 gwei

  source            bid $    ask $  vs oracle  detail
  faroswap-0.01%  0.66700  0.66700     -0.22%  mid 0.66709 USDC, pool holds 400,458 WPROS + 562,614 USDC
  faroswap-0.05%  0.66682  0.66682     -0.25%  mid 0.66692 USDC, pool holds 23,737 WPROS + 11,484 USDC
  faroswap-0.3%   0.66782  0.66782     -0.10%  mid 0.66791 USDC, pool holds 152,599 WPROS + 141,604 USDC
  okx             0.66635  0.66705     -0.27%  bid 0.6672 / ask 0.6679 USDT, 304+400 levels
  bitget          0.66675  0.66715     -0.23%  bid 0.6676 / ask 0.668 USDT, 88+146 levels
  mexc            0.66565  0.66715     -0.31%  bid 0.6665 / ask 0.668 USDT, 39+69 levels
  left out: faroswap-1%: only 58 USDC in the pool (min 1000)

best 8 of 24 routes, by net
  route                             size    gross    fees  slippage     gas  rebalance      net    net %
  buy okx → sell faroswap-0.01%     $200  -0.008%  $0.220    $0.107  $0.001     $0.000  -$0.345  -0.173%
  buy faroswap-0.01% → sell bitget  $200  -0.037%  $0.220    $0.114  $0.001     $0.000  -$0.408  -0.204%
  buy bitget → sell faroswap-0.01%  $200  -0.023%  $0.220    $0.061  $0.001     $0.100  -$0.428  -0.214%
  ...

DECISION  SKIP: best: buy okx → sell faroswap-0.01% at $200: gross -0.008% (-$0.017), fees $0.220, slippage
$0.107, gas $0.001, rebalance $0.000, net -$0.345 (-0.173%). Below the threshold: net -$0.345 < $1.000 and
-0.173% < +0.100%
```

The PROS market is well arbitraged most of the time: spreads of a few hundredths of a percent against
0.1-0.4% of costs. That is the normal case, and the scan says exactly which cost is in the way.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer. No keys, no wallet. Ask your agent to install the skill from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/07-pros-arbitrage/skill/pros-arbitrage`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/07-pros-arbitrage/skill/pros-arbitrage -a claude-code
```

Then ask it "is there a PROS arbitrage right now?", or run the file yourself:

```bash
node .claude/skills/pros-arbitrage/scripts/prosarb.mjs scan
```

```bash
node .claude/skills/pros-arbitrage/scripts/prosarb.mjs watch --every 60
```

```bash
node .claude/skills/pros-arbitrage/scripts/prosarb.mjs config set min_net_usd=0.5 sizes_usd=100,500
```

Settings and `scans.jsonl` live in `%APPDATA%\pros-arbitrage` on Windows and `~/.config/pros-arbitrage`
elsewhere (`PROSARB_HOME` to change it).

## Limits

- Routes assume inventory on both sides (USDC and PROS in a wallet, USDT and PROS on the exchanges), so a trade
  doesn't wait for a transfer. Moving PROS back is priced in (the withdrawal fee); moving USDT back is not.
- The OKX fee page opened in its EU version for me; the base tier there is 0.08% / 0.10%. If yours differs, or
  you have a VIP tier, set it with `config set okx.taker_pct=...`.
- A real DEX trade would go through a router; Faroswap's V3 swaps on Pharos go through its aggregator, so the
  prepared swap is described by pool, amounts and minimum out, and simulated on the pool directly.

## How it's built

- [`src/chain.ts`](src/chain.ts): Faroswap V3 pools, the simulated swaps, Chainlink.
- [`src/cex.ts`](src/cex.ts): the three order books and filling against them.
- [`src/routes.ts`](src/routes.ts): the cost breakdown and the decision (pure functions).
- [`src/scan.ts`](src/scan.ts): one scan, every route; [`src/cli.ts`](src/cli.ts): output, `watch`, the log.
- [`contracts/SwapSimulator.sol`](contracts/SwapSimulator.sol), compiled by `npm run compile` into
  [`src/simulator.ts`](src/simulator.ts).
- [`skill/pros-arbitrage`](skill/pros-arbitrage): `SKILL.md` and the bundled `scripts/prosarb.mjs`.

## Tests

```bash
npm test -w 07-pros-arbitrage
```

Real order books from the three exchanges (`test/fixtures`), filling against a book level by level, the cost
lines adding up to the net, the rebalance with and without, a book too thin never chosen, ACT and SKIP at the
threshold with the reason, and settings typed the way people type them.
