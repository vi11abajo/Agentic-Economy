# 20 · Yield Optimizer

**dent** is an agent skill that tells you whether moving your USDC or PROS to another place on Pharos is worth
it, and if it is, hands the move to your own wallet to sign.

The name is the idea. A lending pool quotes a rate, but that rate is a function of how much cash is in the pool,
and your deposit is more cash. On a small pool your own money dents the rate you were shown. OpenFi's USDC
reserve quoted **1.83%** at block 22290959; asked through its own interest-rate contract what it would pay
with 100 more USDC in it, it answered **0.03%**. dent ranks every place by the rate it would pay *once your
money has landed*, not by the number on the banner.

Then it counts what the move costs (gas estimated from your own address, entry and exit fees, the day Faroo
stPROS makes you wait to unstake, how much cash the pool you're leaving actually has), checks that against how
long you mean to hold, and says **MOVE** with the expected net gain and break-even, or **STAY PUT** with the
reason. A MOVE becomes unsigned transactions on a page served from your own machine; your browser wallet signs.
Before every signature the page asks dent to check again against the live chain.

## Quick start

```bash
cd 20-dent && npm ci && npm run build
node skill/dent/scripts/dent.mjs places
node skill/dent/scripts/dent.mjs look --wallet 0xYourWallet --lane USDC --hold-days 90
node skill/dent/scripts/dent.mjs look --wallet 0xYourWallet --lane PROS --plan plan.json
node skill/dent/scripts/dent.mjs sign plan.json      # then open http://127.0.0.1:8642/
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

| Lane | Place | Contract | How dent reads its rate |
|---|---|---|---|
| USDC | wallet | - | 0 |
| USDC | Avalon main pool (Aave V3 fork) | `0xD9B9E4F8257bFf9B1415d74c1EF88d8057f60cBa` | rate with your deposit, from the reserve's rate strategy; realised from the income index |
| USDC | OpenFi (Aave V3 fork) | `0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26` | same |
| USDC | Zona (Aave V3 fork) | `0xda464e68208a3083eb65fe5c522a72aed1c1372a` | same |
| USDC | RockawayX USDC vault (Morpho Vault V2) | `0x047cd0a91e9b92ed979189a6c8a120bf280f02e5` | realised share price, 7 and 30 days |
| PROS | wallet | - | 0 |
| PROS | Faroo stPROS, liquid staking (Bifrost SLPx) | `0x6b0a44c64190279f7034b77c13a566e914fe5ec4` | realised share price, 7 and 30 days |
| PROS | OpenFi, WPROS | `0x30b2e1411fd2ed9f1f46f59497e2186ce5be3b26` | rate with your deposit |
| PROS | Zona, WPROS | `0xda464e68208a3083eb65fe5c522a72aed1c1372a` | rate with your deposit |
| PROS | Avalon innovative pool, WPROS | `0xdef0EB584700Fc81C73ACcd555cB6cea5FB85C3e` | rate with your deposit |
| PROS | Faroo RWA Hybrid Vault 001 (stPROS) | `0x36f3d19dda7ed1428e3014ae6f2a75d70393b7e6` | share price; deposit simulated: reverts `InvalidPhase(3)`, closed |
| PROS | Faroo Yield Vault 001 (stPROS) | `0xc775dfaa7565f2aca5ddf5dd6837ceb846de591b` | share price; deposit simulated: reverts `InvalidPhase(1)`, closed |

## How a verdict is made

**Rates.** For an Aave fork, dent reads `getReserveData`, then calls the reserve's own
`calculateInterestRates` with `liquidityAdded` = your amount: that is the supply rate the pool would set the
moment your deposit lands. With 0 added it reproduces the pool's current rate (1.939% vs 1.936% quoted on
Avalon, the gap is interest accrued since the last update). The realised rate comes from
`getReserveNormalizedIncome` now and 7 / 30 days ago (blocks found by timestamp, not by an assumed block time).
For vaults and stPROS the rate is the share price (`convertToAssets`) now against 7 and 30 days ago.

**Careful on purpose.** The place your money is now is credited the *best* of its rates; a destination the
*worst* of its rate-with-you and its realised rates. A move has to win with the odds set against it. stPROS
shows why: 31% over the last 7 days, 8.67% over 30 (its share price still read 1.0000 on 2026-10-24), and dent uses 8.67%.

**Costs.**
- Gas: `eth_estimateGas` from your address for every step. Steps that depend on earlier ones (supply after
  approve) are estimated with storage overrides standing in for the earlier step: the balance and allowance
  slots of USDC (9, 10), WPROS (3, 4) and stPROS (OpenZeppelin ERC-7201 namespace) were found by matching
  storage against `balanceOf`. The stPROS claim can't be simulated before its redeem exists, so it uses the
  highest gas of recent real claims (150,493), labelled "observed". USDC-lane gas is priced with the Chainlink
  PROS/USD feed `0x371ed36aee5bffbed1a2aa9b7ded7f4eb30f5466`.
- Entry and exit fees: `previewDeposit` against `convertToShares` and `previewRedeem` against
  `convertToAssets`. For stPROS and RockawayX both pairs match today, so the fee is 0, measured, not assumed.
  Aave V3 supply and withdraw take no fee.
- Waiting: leaving stPROS is `redeem`, then `withdrawCompleteToPROS` after the unbonding wait. dent reads the
  wait from the contract (getter `0x6cf6d675` answers 86400 s; recent real redeems were claimed 24 to 29 h
  later in the explorer) and counts those days as earning nothing.
- Getting out at all: the cash in the pool you're leaving (`balanceOf` the aToken) and the supply cap of the
  one you're entering. A redeem of a vault position is simulated from your address.

**Decision.** `net = what the move earns over the hold - fees - gas - what staying would have earned`. MOVE
needs the destination's rate above yours, break-even within `--hold-days`, and net at least `--min-gain`;
otherwise STAY PUT, and the reason is the first rule the best alternative failed. Every option is printed with
its numbers, closed places with why they are closed.

## Signing: your wallet, not dent

`dent sign plan.json` serves the plan on `127.0.0.1` to a page that uses the wallet already in your browser
(`window.ethereum`), switches it to Pharos (chain 1672) and shows each step's target, value and calldata.
Each button first asks dent to check again: before step 1 dent runs the whole comparison again at the newest
block and keeps the button disabled if the move no longer pays or the best place changed; before every other
step it simulates that exact transaction from your address against the latest block. The page refuses a
wallet other than the one the plan was made for. dent has no signer: no key, no `eth_sendRawTransaction`, and
a test fails if any of that ever shows up in its source.

## Requirements → evidence

| # | Requirement | How dent meets it | Evidence |
|---|---|---|---|
| 1 | Compares at least 3 yield sources using live on-chain data | 5 USDC places and 7 PROS places, every number read at a pinned block | [Proof](#proof), `proof/*.json` (every read: contract, call, block, value) |
| 2 | Accounts for gas, entry/exit fees, and a minimum holding period | estimated gas per step, measured preview fees, unbonding wait, pool cash, `--hold-days` with break-even | the option lines in every proof run |
| 3 | Clear recommendation with expected net gain, or "stay put" with the reason | `MOVE to X: nets N over D days, pays back in B days` / `STAY PUT: <reason>` | runs 1-3 below |
| 4 | Prepares transactions for user signature only; never holds keys | unsigned steps in `plan.json`, local signing page, re-check before each signature, no signer in the code | [signing](#signing-page-re-checks), `src/plan.test.ts` |

## Limits

- A vault (RockawayX) spreads deposits over Morpho markets; how much your deposit lowers *its* rate is not
  modelled. dent says so in the output and falls back to the lower of its 7- and 30-day realised rates.
- Rates are simple annual rates from the last 7 and 30 days. They are history, not a promise.
- dent plans moves between the places above. It doesn't plan deposits into the Faroo vaults (they are closed
  and take stPROS, not PROS); it shows them and why.
- A what-if amount bigger than the wallet holds can't have its exit simulated; dent says so.

## Tests

`npm test` (after `npm run build`): 16 tests: the move-or-stay arithmetic and every STAY PUT reason, the steps
for each kind of move (approve/supply, the two-phase stPROS exit, wrap/unwrap), the storage-override slots,
revert decoding (`InvalidPhase(3)`, Aave codes), and the no-key guard.

## Proof

All runs on Pharos mainnet through `https://rpc.pharos.xyz`, full output and every read in `proof/`.

### 1. Small money, short hold: STAY PUT, and why

Test wallet `0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb`, 0.49979 USDC, 30-day hold, block 22290930
([`proof/01-test-wallet-usdc-30d.txt`](proof/01-test-wallet-usdc-30d.txt)):

```text
  - RockawayX USDC vault: 4.37% (realised over 30 days); extra yield 0.001796 - fees 0 - gas 0.002826 = net -0.00103 USDC; break-even 48 days.
STAY PUT: best alternative RockawayX USDC vault pays back only after 48 days, longer than your 30-day hold
```

### 2. Your deposit dents the rate

Same wallet, what-if 100 USDC, 90-day hold, block 22290959
([`proof/02-what-if-100-usdc.txt`](proof/02-what-if-100-usdc.txt)). OpenFi quotes 1.83% and would pay 0.03%
with the 100 in it; Avalon, with 502k USDC supplied, barely moves:

```text
place                           you hold        now     with you  7d real  30d real  status
Avalon main pool, USDC          -               1.94%   1.94%     1.93%    1.93%     open
OpenFi, USDC                    -               1.83%   0.03%     1.83%    1.72%     open
  - OpenFi, USDC: 0.03% (with your deposit in it); extra yield 0.00683 - fees 0 - gas 0.002015 = net 0.004815 USDC; break-even 27 days.
MOVE to RockawayX USDC vault: nets 1.07472 over 90 days, pays back in 1 days
```

### 3. A real stPROS holder: stake the idle PROS with Faroo

`0xb29eaea575bd4bae7d9a301446e6204c3a23adf1`, a wallet that uses Faroo (not ours), PROS lane, 30-day hold,
block 22290978 ([`proof/03-stpros-holder-pros.txt`](proof/03-stpros-holder-pros.txt)):

```text
PROS left in the wallet         4.6404 PROS     0.00%   -         -        -         open
Faroo stPROS (liquid staking)   0.480724 PROS   31.03%  -         31.03%   8.67%     open
OpenFi, WPROS                   -               0.38%   0.00%     0.38%    0.34%     open
Faroo RWA Hybrid Vault 001      2.08044 PROS    0.00%   -         0.00%    0.00%     closed: deposit reverts: InvalidPhase(3)
Faroo Yield Vault 001           1.9739 PROS     0.00%   -         0.00%    0.00%     closed: deposit reverts: InvalidPhase(1)
  - Faroo stPROS (liquid staking): 8.67% (realised over 30 days); extra yield 0.033044 - fees 0 - gas 0.001414 = net 0.03163 PROS; break-even 2 days.
MOVE to Faroo stPROS (liquid staking): nets 0.03163 over 30 days, pays back in 2 days
  1. [phase 1] stake 4635395121798579945 wei PROS with Faroo for stPROS -> 0x6b0a44c64190279f7034b77c13a566e914fe5ec4  gas 141447 (estimated)
```

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
