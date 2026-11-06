# 20 · Yield Optimizer

**dent** is an agent skill that tells you whether moving your USDC or PROS to another place on Pharos is worth
it, and if it is, hands the move to your own wallet to sign.

The name is the idea. A lending pool quotes a rate, but that rate is a function of how much cash is in the pool,
and your deposit is more cash. On a small pool your own money dents the rate you were shown. OpenFi's USDC
reserve quoted **1.83%** at block 22304589; asked through its own interest-rate contract what it would pay
with 100 more USDC in it, it answered **0.03%**. dent ranks every place by the rate it would pay *once your
money has landed*, not by the number on the banner. For Aave forks and Morpho Blue markets that rate comes from
the pool's own rate contract; for the RockawayX vault dent rebuilds it from the Morpho markets the vault lends into.

Then it counts what the move costs (gas estimated from your own address, entry and exit fees, the day Faroo
stPROS makes you wait to unstake, how much cash the pool you're leaving actually has), checks that against how
long you mean to hold, and says **MOVE** with the expected net gain and break-even, or **STAY PUT** with the
reason. A MOVE becomes unsigned transactions on a page served from your own machine; your browser wallet signs.
Before every signature the page asks dent to check again against the live chain.

And because a rule is only as good as what it would have done, `dent backtest` replays the same rule on the
chain's history and puts it next to simply parking the money in one place. In both lanes, parking won.
That's in the [proof](#5-backtest-would-the-rule-have-paid), not hidden.

## Quick start

```bash
cd 20-dent && npm ci && npm run build
node skill/dent/scripts/dent.mjs places
node skill/dent/scripts/dent.mjs look --wallet 0xYourWallet --lane USDC --hold-days 90
node skill/dent/scripts/dent.mjs look --wallet 0xYourWallet --lane PROS --plan plan.json
node skill/dent/scripts/dent.mjs sign plan.json      # then open http://127.0.0.1:8642/
node skill/dent/scripts/dent.mjs backtest --lane USDC --days 56 --every 7   # about 5 minutes
```

The skill is `skill/dent/` (SKILL.md plus one bundled script, no install, no keys).

| Flag | Meaning |
|---|---|
| `--lane USDC\|PROS` | which money to look at |
| `--from <place>` | where it is now; default: wherever the wallet holds the most in that lane |
| `--amount N` | how much to move; default: all of it (PROS in the wallet keeps `--keep-pros`, 0.005, for gas) |
| `--hold-days N` | the minimum holding period: how long you'll leave it. Default 30 |
| `--min-gain X` | smallest net gain worth signing for, in lane units. Default 0.01 USDC / 0.001 PROS |
| `--plan file` | on MOVE, write the transactions for `dent sign` |

## The places

All checked on chain on 2026-11-06 before going in; whether each one is open is decided live, every run.

| Lane | Place | Contract / market id | How dent reads its rate |
|---|---|---|---|
| USDC | wallet | - | 0 |
| USDC | Avalon main pool (Aave V3 fork) | `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` | rate with your deposit, from the reserve's rate strategy; realised from the income index |
| USDC | OpenFi (Aave V3 fork) | `0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26` | same |
| USDC | Zona (Aave V3 fork) | `0xda464e68208a3083eb65fe5c522a72aed1c1372a` | same |
| USDC | RockawayX USDC vault (Morpho Vault V2) | `0x047cd0a91e9b92ed979189a6c8a120bf280f02e5` | rate with your deposit modelled from its Morpho markets; realised share price |
| USDC | Morpho Blue, lend against WPROS | `0xb3b8a31c…a449e1ba` | rate with your deposit from the market's IRM; realised share price |
| USDC | Morpho Blue, lend against wsrUSD | `0xbea21c37…8ac49e73` | same |
| USDC | Morpho Blue, lend against syzUSD | `0xc79579a0…9e16fd86` | same |
| USDC | Morpho Blue, lend against APC3M | `0xba0d2638…149d91bc` | same |
| USDC | Morpho Blue, lend against strUSD | `0x4cbedaf6…2bb429cd` | same |
| USDC | Morpho Blue, lend against APT | `0xd834016e…14ae5aea` | same |
| PROS | wallet | - | 0 |
| PROS | Faroo stPROS, liquid staking (Bifrost SLPx) | `0x6b0a44c64190279f7034b77c13a566e914fe5ec4` | realised share price, 7 and 30 days |
| PROS | OpenFi, WPROS | `0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26` | rate with your deposit |
| PROS | Zona, WPROS | `0xda464e68208a3083eb65fe5c522a72aed1c1372a` | rate with your deposit |
| PROS | Avalon innovative pool, WPROS | `0xdef0EB584700Fc81C73ACcd555cB6cea5FB85C3e` | rate with your deposit |
| PROS | Morpho Blue, lend WPROS against BTCVC | `0x6657f8b7…34ad2faa` | rate with your deposit from the IRM |
| PROS | Morpho Blue, lend WPROS against bfBTC | `0xce1289ae…92dbf347` | same |
| PROS | Faroo RWA Hybrid Vault 001 (stPROS) | `0x36f3d19dda7ed1428e3014ae6f2a75d70393b7e6` | share price × stPROS price; deposit reverts `InvalidPhase(3)`, redeem goes through: closed to enter, open to leave |
| PROS | Faroo Yield Vault 001 (stPROS) | `0xc775dfaa7565f2aca5ddf5dd6837ceb846de591b` | same; deposit and redeem both revert `InvalidPhase(1)` |

Morpho market ids are shortened here; the full 32-byte ids are in `src/venues.ts`, and every market lives on the
Morpho Blue singleton `0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb`.

The Morpho markets are the ones on the Pharos singleton that lend USDC or WPROS and hold real money; the others
held next to nothing when listed, and a sweep of `CreateMarket` logs from block 21770890 to 22302918 found no
market created since. All of them use the IRM `0xD5E02889c13230458506cc842347c4e62f8cdf3a`.

## How a verdict is made

**Rates with your money in.**
- Aave forks: dent reads `getReserveData`, then calls the reserve's own `calculateInterestRates` with
  `liquidityAdded` = your amount: the supply rate the pool would set the moment your deposit lands. With 0
  added it reproduces the pool's current rate.
- Morpho Blue: `borrowRateView` on the market's IRM with your amount added to total supply, times utilisation,
  times (1 − market fee).
- RockawayX (Morpho Vault V2): the vault's `liquidityAdapter` and `liquidityData` say where new deposits go (the
  strUSD market); the adapter lists the markets it holds and how much is in each. dent computes each market's
  rate the Morpho way, adds your deposit to the liquidity market, counts the idle part of the vault as earning
  nothing and takes the 15% performance fee off. At block 22304589 that gives 2.85%, against 4.53% realised over
  7 days; the 25% of the vault sitting idle is most of the gap. dent says it is a model, in the output.
- Realised rates for everything: the income index or share price now against 7 and 30 days ago (blocks found by
  timestamp, not by an assumed block time).

**Careful on purpose: window by window.** Each option is compared with where your money is *in the same
window*: now against now, last 7 days against last 7 days, last 30 against last 30. A destination is never
credited more than it would pay with your money in it. Of the windows both places have, the one worst for the
move counts. Comparing like with like matters: a Faroo vault holds stPROS, so in PROS it earns exactly what
stPROS earns; best-of-mine against worst-of-theirs would have called "leave the vault for plain stPROS" a loss
when the two are the same rate (31.03% against 31.03% in [run 4](#4-out-of-a-faroo-vault-same-money-same-rate)).

**Costs.**
- Gas: `eth_estimateGas` from your address for every step. Steps that depend on earlier ones (supply after
  approve) are estimated with storage overrides standing in for the earlier step: the balance and allowance
  slots of USDC (9, 10), WPROS (3, 4) and stPROS (OpenZeppelin ERC-7201 namespace) were found by matching
  storage against `balanceOf`. The stPROS claim can't be simulated before its redeem exists, so it uses the
  highest gas of recent real claims (150,493), labelled "observed". USDC-lane gas is priced with the Chainlink
  PROS/USD feed `0x371ed36aee5bffbed1a2aa9b7ded7f4eb30f5466`.
- Entry and exit fees: `previewDeposit` against `convertToShares` and `previewRedeem` against
  `convertToAssets`. For stPROS and RockawayX both pairs match today, so the fee is 0, measured, not assumed.
  Aave V3 and Morpho Blue supply and withdraw take no fee.
- Waiting: leaving stPROS is `redeem`, then `withdrawCompleteToPROS` after the unbonding wait. dent reads the
  wait from the contract (getter `0x6cf6d675` answers 86400 s; recent real redeems were claimed 24 to 29 h
  later in the explorer) and counts those days as earning nothing. Leaving a Faroo vault for anything but
  stPROS goes through the same wait, so it is counted there too.
- Getting out at all: the cash in the pool you're leaving (`balanceOf` the aToken; supply minus borrow in a
  Morpho market) and the supply cap of the one you're entering. Redeems of vault positions are simulated from
  your address; a vault whose redeem reverts is a STAY PUT with the revert as the reason.

**Decision.** `net = what the move earns over the hold - fees - gas - what staying would have earned`. MOVE
needs the destination's rate above yours, break-even within `--hold-days`, and net at least `--min-gain`;
otherwise STAY PUT, and the reason is the first rule the best alternative failed. Every option is printed with
its numbers, closed places with why they are closed.

## Things dent saw on the way

On 2026-11-06 at 18:30:38 UTC (block 22302862) Avalon's main pool swapped the rate strategy of its USDC reserve
through its Safe (`execTransaction`, tx
[`0x1e75012b…c4f97ac5`](https://www.pharosscan.xyz/tx/0x1e75012b9c68679ba99621a719a3e77f0f6a59de2cfc119c8975d144c4f97ac5)):
strategy `0x4f9847…` became `0x6e9fa03d…`, and the supply rate went from 1.936% to 0.003%. Its realised 7-day
rate still read 1.92% 26 minutes later, because history doesn't change when a strategy does. dent's window-by-window rule shows both numbers side
by side (`now 0.00%`, `7d real 1.92%` in [run 2](#2-your-deposit-dents-the-rate)), and the now-window is the one
that counts against a move into Avalon.

## Signing: your wallet, not dent

`dent sign plan.json` serves the plan on `127.0.0.1` to a page that uses the wallet already in your browser
(`window.ethereum`), switches it to Pharos (chain 1672) and shows each step's target, value and calldata.
Each button first asks dent to check again: before step 1 dent runs the whole comparison again at the newest
block and keeps the button disabled if the move no longer pays or the best place changed; before every other
step it simulates that exact transaction from your address against the latest block. The page refuses a
wallet other than the one the plan was made for. Two-phase moves (out of stPROS, or out of a Faroo vault into
anything but stPROS) mark the claim and what follows it as phase 2: run `dent sign` on the same plan again after
the wait. dent has no signer: no key, no `eth_sendRawTransaction`, and a test fails if any of that ever shows up
in its source.

## Requirements → evidence

| # | Requirement | How dent meets it | Evidence |
|---|---|---|---|
| 1 | Compares at least 3 yield sources using live on-chain data | 11 USDC places and 9 PROS places, every number read at a pinned block | [Proof](#proof), `proof/*.json` (every read: contract, call, block, value) |
| 2 | Accounts for gas, entry/exit fees, and a minimum holding period | estimated gas per step, measured preview fees, unbonding wait, pool cash, `--hold-days` with break-even | the option lines in every proof run |
| 3 | Clear recommendation with expected net gain, or "stay put" with the reason | `MOVE to X: nets N over D days, pays back in B days` / `STAY PUT: <reason>` | runs 1-4 below |
| 4 | Prepares transactions for user signature only; never holds keys | unsigned steps in `plan.json`, local signing page, re-check before each signature, no signer in the code | [signing](#signing-page-re-checks), `src/plan.test.ts` |

## Limits

- The RockawayX rate with you is a model (its markets, its idle share, its fee), not a contract answer like the
  Aave and Morpho ones. Today it comes out below the vault's realised rate; dent uses the lower.
- Rates are simple annual rates. Realised ones are history, not a promise; "with you" ones hold until someone
  else borrows, repays or deposits.
- The backtest charges today's gas at every checkpoint (history keeps no gas estimates) and charges leaving a
  place what entering it costs. It says so in its output.
- dent plans moves between the places above. It doesn't plan deposits into the Faroo vaults (both are closed
  to deposits today); it plans leaving FRHV001, whose redeem goes through, and says why FYV001 can't be left.
- A what-if amount bigger than the wallet holds can't have its exit simulated; dent says so.

## Tests

`npm test` (after `npm run build`): 21 tests: the window-by-window comparison (including two places with the
same underlying rate), the move-or-stay arithmetic and every STAY PUT reason, the steps for each kind of move
(approve/supply, Morpho supply with market params and full exit by shares, the two-phase stPROS exit, leaving
a Faroo vault into stPROS in one step or elsewhere in six), the storage-override slots, revert decoding
(`InvalidPhase(3)`, Aave codes), and the no-key guard.

## Proof

All runs on Pharos mainnet through `https://rpc.pharos.xyz`, full output and every read in `proof/`.

### 1. Small money, short hold: STAY PUT, and why

Test wallet `0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb`, 0.49979 USDC, 30-day hold, block 22304524
([`proof/01-test-wallet-usdc-30d.txt`](proof/01-test-wallet-usdc-30d.txt)):

```text
  - RockawayX USDC vault: 2.85% vs your 0.00% (now, with your deposit in it); extra yield 0.001173 - fees 0 - gas 0.002853 = net -0.00168 USDC; break-even 73 days.
  - Morpho, lend USDC against APC3M: 5.97% vs your 0.00% (now, with your deposit in it); extra yield 0.002454 - fees 0 - gas 0.001097 = net 0.001357 USDC; break-even 14 days.
STAY PUT: best alternative Morpho, lend USDC against APC3M nets 0.00135681 over 30 days, below your minimum gain of 0.01
```

### 2. Your deposit dents the rate

Same wallet, what-if 100 USDC, 90-day hold, block 22304589
([`proof/02-what-if-100-usdc.txt`](proof/02-what-if-100-usdc.txt)). OpenFi quotes 1.83% and would pay 0.03%
with the 100 in it; RockawayX's model falls from its 4.53% realised to 2.85%; Avalon reads 0.00% now after its
strategy change:

```text
place                           you hold        now     with you  7d real  30d real  status
Avalon main pool, USDC          -               0.00%   0.00%     1.92%    1.93%     open
OpenFi, USDC                    -               1.83%   0.03%     1.83%    1.73%     open
RockawayX USDC vault            -               4.53%   2.85%     4.53%    4.37%     open
Morpho, lend USDC against APC3M -               5.97%   5.97%     12.46%   8.71%     open
Morpho, lend USDC against WPROS -               7.25%   7.24%     7.08%    5.93%     open
  - Morpho, lend USDC against WPROS: 5.93% vs your 0.00% (over the last 30 days); ... net 1.461645 USDC; break-even 1 day.
  - Morpho, lend USDC against APC3M: 5.97% vs your 0.00% (now, with your deposit in it); ... net 1.471452 USDC; break-even 1 day.
MOVE to Morpho, lend USDC against APC3M: nets 1.47145 over 90 days, pays back in 1 day
```

The WPROS market quotes the most now (7.25%), but its 30-day window is 5.93%, so APC3M wins.

### 3. A real stPROS holder: stake the idle PROS with Faroo

`0xb29eaea575bd4bae7d9a301446e6204c3a23adf1`, a wallet that uses Faroo (not ours), PROS lane, 30-day hold,
block 22304628 ([`proof/03-stpros-holder-pros.txt`](proof/03-stpros-holder-pros.txt)):

```text
PROS left in the wallet         4.6404 PROS     0.00%   -         -        -         open
Faroo stPROS (liquid staking)   0.480724 PROS   31.03%  -         31.03%   8.67%     open
OpenFi, WPROS                   -               0.38%   0.00%     0.38%    0.34%     open
Faroo RWA Hybrid Vault 001      2.08044 PROS    31.03%  -         31.03%   8.67%     closed: deposit reverts: InvalidPhase(3)
Faroo Yield Vault 001           1.9739 PROS     31.03%  -         31.03%   8.67%     closed: deposit reverts: InvalidPhase(1)
  - Faroo stPROS (liquid staking): 8.67% vs your 0.00% (over the last 30 days); extra yield 0.033044 - fees 0 - gas 0.001414 = net 0.03163 PROS; break-even 2 days.
MOVE to Faroo stPROS (liquid staking): nets 0.03163 over 30 days, pays back in 2 days
  1. [phase 1] stake 4635395121798579945 wei PROS with Faroo for stPROS -> 0x6b0a44c64190279f7034b77c13a566e914fe5ec4  gas 141447 (estimated)
```

### 4. Out of a Faroo vault: same money, same rate

The same holder, asking about the 2.08 PROS in Faroo RWA Hybrid Vault 001, block 22304665
([`proof/04-faroo-vault-exit.txt`](proof/04-faroo-vault-exit.txt)). The vault's redeem goes through; its own layer
has earned nothing on top of stPROS, so leaving would only cost gas:

```text
  - Faroo stPROS (liquid staking): 31.03% vs your 31.03% (now); extra yield 0 - fees 0 - gas 0.001063 = net -0.001063 PROS; break-even never.
STAY PUT: best alternative Faroo stPROS (liquid staking) pays 31.03% now, not more than the 31.03% you get in the same window
note (Faroo RWA Hybrid Vault 001): redeeming your shares goes through right now
```

### 5. Backtest: would the rule have paid?

100 units, starting in the wallet, checkpoints every 7 days over 56 days (2026-09-11 to 2026-11-06), 30-day hold
([`proof/05-backtest-usdc.txt`](proof/05-backtest-usdc.txt), [`proof/06-backtest-pros.txt`](proof/06-backtest-pros.txt)).

```text
USDC: the rule: ends with 100.78079 USDC after 2 move(s), 0.0036315602 USDC of it spent on gas
  Morpho, lend USDC against syzUSD     100.81199 USDC   <- beat the rule
  Morpho, lend USDC against WPROS      100.78622 USDC   <- beat the rule
  RockawayX USDC vault                 100.61357 USDC
  Avalon main pool, USDC               100.29269 USDC

PROS: the rule: ends with 100.60312 PROS after 2 move(s), 0.00668977 PROS of it spent on gas
  Faroo stPROS (liquid staking)        100.70958 PROS   <- beat the rule
  Morpho, lend WPROS against BTCVC     100.01796 PROS
```

What that says: the rule went to syzUSD on day one and was right, then hopped to APT on 2026-10-30 and lost a
little. In PROS it sat in a 0.18% Morpho market through October, when stPROS's share price still read 1.0000
(it started moving on 2026-10-24), and only moved to stPROS on 2026-10-30. A rule that only acts on what it can
already see is late to a rate that appears overnight. With these markets, picking one good place and staying
beat moving, and dent's backtest is there so you can check that before you sign anything.

### Signing page re-checks

`dent sign` on a 365-day plan for the test wallet (approve + deposit into RockawayX), the server's log:

```text
recheck step 1: OK - still worth it at block 22290840: net 0.019022 USDC over 365 days, break-even 48 days
recheck step 2: BLOCKED - this step would revert now: custom error 0xe65b7a77
recheck step 1: BLOCKED - this plan was made for 0x46441dc99f8000959e9c48cf2a01a018d131d3bb; the wallet connected is 0x1111111111111111111111111111111111111111
```

Step 2 is the deposit, checked before its approve had landed: the vault's `TransferFromReverted()`
(`0xe65b7a77`, decoded by name since) is exactly what it should say, and the page keeps that button disabled until
step 1 is mined.
