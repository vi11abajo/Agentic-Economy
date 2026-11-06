# 21 · Liquidation Watchdog

**lastcall** is an agent skill that watches lending positions on Pharos mainnet and warns the borrower while
there's still time to do something: it reads the loan, says how much time is left, says what to repay or add,
and has already tried that fix on the real contracts before it says so.

I started from the obvious watchdog (health factor, thresholds, "the price can fall N% before you're
liquidated") and then looked at who actually borrows on Pharos. The biggest loans aren't the kind that price
drop math is good at:

- **The big Morpho loans are loops on vault shares.** A wallet owes 1,527,386 USDC against 1,547,471 syzUSD at
  health **1.0140**. That looks like a loan a whisker from liquidation. But the syzUSD oracle only went up over
  the last week (7.50% a year, every daily sample at or above the one before), and the loan costs 5.91%. Its
  health is *growing* on its own. "Liquidated if syzUSD falls 1.4%" would be a scary sentence about something
  this oracle doesn't do. What can actually kill this loan is the borrow rate: the market is 90% used, and if
  its suppliers pulled their spare cash, Morpho's own rate model says the borrow rate would be **23.72%**. Then
  health shrinks 16.21% a year and the loan has **about 31 days**. So lastcall runs a **carry clock**: what
  the collateral earns against what the debt costs, today and in that stress case, turned into days.
- **The Aave forks have real BTC risk.** The two big Avalon borrowers I found hold 8.5 and 10.45 FBTC against
  251,909 and 196,479 USDC. There the price is the risk, and lastcall says it plainly: FBTC can fall 44.0% and
  64.5% before those loans hit 1.0.
- **The rules can change under you.** On 2026-11-06 at 18:30 UTC, Avalon's admin Safe swapped the interest-rate
  strategy for USDC, WETH and FBTC in one transaction. No timelock, no warning on chain. lastcall watches each
  pool's admin contracts and, when a change lands, re-reads every watched loan one block before and in the
  change block and says what moved. For that swap: USDC borrow **3.96% -> 0.01%**, health unchanged. Good news
  for those borrowers that time, but the same door is open for a change that isn't.
- **Advice should be tried before it's given.** "Repay 494,855 USDC" is arithmetic. lastcall then puts a tiny
  contract on the borrower's own address inside an `eth_call` state override, so `approve -> repay -> read
  health` runs as the borrower against the live pool, and prints the health the contract itself computed after
  the move. Nothing is signed or sent; the public node never sees a transaction.

It reads Morpho Blue (16 known markets plus any `--market`) and the four Aave V3 forks on Pharos (Avalon,
Avalon innovative, OpenFi, Zona). Alerts go to the console with timestamps, and to Telegram and/or Discord.

## Quick start

```bash
cd 21-lastcall
npm install
npm run build          # also bundles skill/lastcall/scripts/lastcall.mjs
npm test

node skill/lastcall/scripts/lastcall.mjs look --wallet 0xA4A57DcF7B15456b7053f10A377Bdb437C073DCc
node skill/lastcall/scripts/lastcall.mjs watch --wallet 0x... --every 60 --telegram
node skill/lastcall/scripts/lastcall.mjs replay --pool avalon --wallet 0xd360d59d3d9449c6cec9e6f50046b57cc67fe7a0 --block 22302862
node skill/lastcall/scripts/lastcall.mjs scan --hours 24
```

As an agent skill: copy `skill/lastcall/` into your agent's skills folder. `scripts/lastcall.mjs` is one
bundled file that runs on plain Node 20+, no install. `SKILL.md` tells the agent how to run it, how to set up
Telegram or Discord with the user, and how to explain an alert.

Thresholds are flags: `--warn 1.3 --critical 1.1` (the defaults), `--target 1.5` is the health the advice aims
at, `--rearm 0.02` is how far health has to climb back above a line before that level clears (so a loan
hovering at 1.30 doesn't alert every round), and `--days-warn 30` raises a clock alert when the carry leaves
fewer days than that even if the health factor still looks fine. Bad orders are refused (`--warn` must be above
`--critical`, `--critical` above 1.0, `--target` above `--warn`).

## What it reads

| Venue | Calls | Health |
|---|---|---|
| Avalon, Avalon innovative, OpenFi, Zona (Aave V3) | `getUserAccountData`, `getReservesList`, `getReserveData`, `getUserConfiguration`, aToken and debt token `balanceOf`, the pool oracle's `getAssetPrice` | the pool's own `healthFactor`; each reserve also as a leg (amount, USD value, liquidation threshold if it's used as collateral) |
| Morpho Blue `0x18573fa1…4efb` | `idToMarketParams`, `market`, `position`, the market oracle's `price`, the rate model's `borrowRateView` | rebuilt the way Morpho decides liquidations: `collateral x price / 1e36 x LLTV` against the debt, with interest since the market's last update accrued first (Morpho's Taylor expansion, virtual shares) |

All reads in one look are pinned to one block. Oracle prices are also read at 8 points over the last 7 days
(each block's real timestamp is used), which is where the "climbing / moving / flat" shape of each collateral
comes from.

## How a loan gets graded

**Level.** `liquidatable` below 1.0, `critical` up to `--critical`, `warn` up to `--warn`, else `ok`. In
`watch`, getting worse alerts at once; getting better needs `--rearm` of headroom.

**Price risk.** Only collateral that actually moves counts: its oracle went up and down in the last week, and
it isn't the same token as the debt (USDC posted against a USDC loan wobbles on both sides at once). The number
is how far those legs can fall, all together, before health hits 1.0. If the rest of the collateral covers the
debt even at zero, it says so. If nothing moves, there's no price-drop number at all.

**Carry clock.** Collateral side: supply APR (Aave) plus the oracle's drift where the shape is "climbing".
Debt side: the borrow APR. If the debt grows faster, health lasts `ln(health) / gap` years. The stress version
charges the debt the rate the pool's own rate contract quotes at 100% use: Morpho's `borrowRateView` with total
supply set equal to total borrow, Aave's `calculateInterestRates` with all the reserve's cash taken.

**Advice.** Two ways back to `--target`: repay part of the biggest debt, or add more of the collateral that
counts the most. When the carry clock is under `--days-warn`, the aim goes up to whatever buys twice that many
days. Then both moves are rehearsed (below) and the alert shows the rehearsed health and how much of that
token the wallet really holds.

**Rules.** For a Morpho market lastcall hashes the params and checks the hash equals the market id. It does for
the syzUSD market in the proof, which means nobody can change that market's oracle, LLTV or rate model later: a
different setting would be a different market. For an Aave fork it reads who owns the addresses provider and
asks it whether it's a Safe or a timelock. Avalon: Safe `0xc6f56760…84f4`, 3 of 5 signers, no timelock. In
`watch`, each round reads the logs of the pool configurator, the addresses provider, the price oracle and the
owner since the previous round, decodes the known admin events, and for any real change (not just the Safe's
own `ExecutionSuccess` paperwork) shows the loan before vs after.

## Rehearsal: trying the fix as the borrower

Pharos' public node doesn't have `eth_simulateV1`, so a "do these three things in a row, then tell me the
health" simulation isn't on the menu. What it does have is the state override on `eth_call`, including `code`.
[`contracts/Runner.sol`](contracts/Runner.sol) is 12 lines: take a list of targets and calldata, call them in
order, revert with the first failure's reason, return every answer. lastcall puts its runtime code on the
borrower's own address (only inside the call) and calls it from that address. Every call Runner makes then has
`msg.sender` = the borrower:

- Aave: `approve(pool)`, `repay(asset, amount, 2, borrower)` or `supply(asset, amount, borrower, 0)`,
  `getUserAccountData(borrower)`.
- Morpho: `accrueInterest`, `approve(Morpho)`, `repay` (by shares when it's the whole debt) or
  `supplyCollateral`, then `position`, `market` and the oracle's `price`.

If the wallet doesn't hold enough of the token, a second override writes the amount into the token's balance
slot for the rehearsal. lastcall finds that slot by writing a marker into each candidate (0..29 and
OpenZeppelin's ERC-7201 ERC-20 namespace) and asking `balanceOf` which one moved. The alert always says what
the wallet really holds, so a topped-up rehearsal never reads as "you can afford this".

Runner was compiled with solc 0.8.24 (optimizer 200, evm paris); the runtime code sits in
[`src/venues.ts`](src/venues.ts) as `RUNNER_CODE`. It is never deployed.

## Limits

- Borrower discovery (`scan`) is by `Borrow` events in a window. A loan whose last borrow is older than the
  window doesn't show up there; `look` and `watch` read any wallet you name.
- Morpho markets are the 16 ids from the CreateMarket sweep in task 20 plus any `--market`; ids that don't
  resolve to params are skipped. A new market isn't found by itself unless `scan` sees a borrow in it.
- The stress clock uses the rate the model gives at 100% use **today**. Morpho's adaptive model keeps raising
  that rate the longer a market stays full, so a real run would run out sooner than the printed number.
- The carry clock assumes prices freeze except for the oracle drift it measured. It is a clock, not a forecast.
- On the Aave forks the debt token's own price drift isn't modelled (all debts seen here are USDC).
- The Aave stress figure needs a V3.0-style rate strategy (`calculateInterestRates` with the 9-field struct);
  if a strategy answers differently, the stress line is left out rather than guessed.
- On the Aave forks a rule change is caught in the block it lands, not before: Avalon's Safe executes directly.
  A Safe owner approving a hash on chain (`ApproveHash`) would be an earlier hint and is decoded, but none was
  seen here; Safe's off-chain signature queue isn't read.
- The OpenFi provider's owner `0x277bc306…e38c` answers neither as a Safe nor as a timelock; lastcall says so
  and doesn't guess what it is.
- Reads are of other people's loans. lastcall alerts; it can't repay, top up or liquidate anything.

## Tests

`npm test`: 17 tests. Thresholds and their order checks, levels and the rearm band, price drop for volatile
collateral and the same-token case, the carry clock on the real syzUSD loop's numbers (growing now, 30-33 days
under stress), move sizes hitting the target without overshooting, the raised aim for a short clock, oracle
shapes, Morpho's id-equals-hash check on the real syzUSD market params, Taylor compounding, decoding the real
Avalon strategy-swap logs, secrets hidden in errors, and delivery to the console, Telegram and Discord through
a fake network.

## Proof

Everything below was read from Pharos mainnet (chain 1672) through https://rpc.pharos.xyz on 2026-11-06. The
loans belong to third parties found on chain; nothing was signed or sent by anyone here.

### 1. Four real loans, one look

[`proof/01-four-real-loans.txt`](proof/01-four-real-loans.txt) (and [`.json`](proof/01-four-real-loans.json)),
block 22317005, 373 reads, 55 s:

```text
# | venue | wallet | health | level | price risk | days left (now / stress) | debt
1 | Morpho syzUSD/USDC | 0xA4A5…3DCc | 1.0140 | critical | no price risk | growing / 31 | 1,527,386.75 USDC
2 | OpenFi | 0xf4df…a989 | 1.0403 | critical | covered | 1051 / 19 | $4.59
3 | Avalon | 0xd360…e7a0 | 1.7870 | ok | -44.0% | >10y / >10y | $251,843.91
4 | Avalon | 0xf5cb…db13 | 2.8167 | ok | -64.5% | >10y / >10y | $196,428.07
```

The syzUSD loop's alert, in full:

```text
CRITICAL Morpho syzUSD/USDC 0xA4A5…3DCc: health 1.0140 (debt 1,527,386.75 USDC, collateral 1,547,470.9 syzUSD)
syzUSD oracle only climbed in 7 days (7.50%/yr, NAV-style), so a price drop isn't the risk here
carry now: health is growing on its own (collateral 7.50%/yr vs debt 5.91%/yr)
carry if every spare unit of supply left the market (borrow 23.72%): health shrinks 16.21%/yr (collateral 7.50% vs debt 23.72%), about 31 days to liquidation if nothing else moves
act to get back to 1.50: repay 494,854.57 USDC -> health 1.5000 (rehearsed on the real Morpho contract at block 22317005; you hold 0 USDC)  OR  add 741,645.68 syzUSD collateral -> health 1.5000 (rehearsed on the real Morpho contract at block 22317005; you hold 0 syzUSD)
rules: fixed: the market id is the hash of its oracle, LLTV and rate model (checked), nobody can change them
```

The OpenFi loan is tiny but real, and it shows the same-token rule: 6.07 USDC + 0.10 WPROS against 4.59 USDC,
health 1.0403. A price-drop number would say "WPROS falls 3.9%"; lastcall says even WPROS at zero leaves the
debt covered, because most of the collateral is the same USDC as the debt. What can hurt it is the rate: OpenFi's
USDC strategy quotes 79.00% at full use, which would leave 19 days.

Arithmetic vs rehearsal, from the JSON (`expectedHf` vs `hfAfter`):

| Loan | Move | Arithmetic | Real contract after the move |
|---|---|---|---|
| Morpho syzUSD/USDC | repay 494,854.565326 USDC | 1.5 | 1.500000000001 |
| Morpho syzUSD/USDC | add 741,645.68 syzUSD | 1.5 | 1.5 |
| OpenFi | repay 1.407994 USDC | 1.5 | 1.50000094 |
| OpenFi | add 2.707678 USDC | 1.5 | 1.50000018 |

All four needed a balance top-up inside the rehearsal (`toppedUp: true`), because none of these wallets holds
the token right now; the alert says "you hold 0 USDC" for exactly that reason.

### 2. Who's borrowing this week

[`proof/02-scan-7-days.txt`](proof/02-scan-7-days.txt): every `Borrow` event on Morpho and the four Aave forks
in the last 7 days, then each borrower's loans read live.

Started at block 22317073 (21:58 UTC), 693 log windows, 11 borrows by 11 wallets, about an hour in all on the
public node:

```text
# | venue | wallet | health | level | price risk | days left (now / stress) | debt
1 | Morpho syzUSD/USDC | 0xe6a4…fe7c | 1.0056 | critical | no price risk | growing / 13 | 1,535,479.5 USDC
2 | Morpho syzUSD/USDC | 0x96b7…37b6 | 1.0057 | critical | no price risk | growing / 13 | 168,677.49 USDC
3 | Morpho strUSD/USDC | 0x6cc3…0e29 | 1.0210 | critical | no price risk | growing / 188 | 182,564.45 USDC
4 | Morpho wsrUSD/USDC | 0x086e…e327 | 1.0526 | critical | no price risk | growing / 132 | 18,004,218.12 USDC
5 | Morpho strUSD/USDC | 0xe176…756f | 1.0736 | critical | no price risk | growing / 642 | 579,167.31 USDC
6 | Morpho APT/USDC | 0x32d8…7707 | 1.1150 | warn | no price risk | growing / 203 | 2,771.55 USDC
7 | Morpho strUSD/USDC | 0x2e3d…90e5 | 1.1716 | warn | no price risk | growing / 1432 | 800,012.65 USDC
8 | Morpho bfBTC/WPROS | 0xe5b9…7ffb | 1962.9420 | ok | -99.9% | >10y / >10y | 10,000.1 WPROS
9 | Avalon | 0xa4a1…37e1 | 17565.2371 | ok | no price risk | >10y / >10y | $10
```

This is the picture the whole tool is built around. Seven loans are under 1.2, five of them "critical" by the
default thresholds, and every one of them has health that is *growing* at today's rates, because each sits on
a vault share whose oracle only climbed this week. Ranking them by a price drop would be ranking them by
something that isn't happening. Ranking by the stress clock puts the two syzUSD loans first: at 1.0056, a
syzUSD market drained of spare cash would liquidate them in about 13 days.

### 3. Replaying Avalon's rule change

[`proof/03-replay-avalon-rule-change.txt`](proof/03-replay-avalon-rule-change.txt). Block 22302862, tx
`0x1e75012b9c68679ba99621a719a3e77f0f6a59de2cfc119c8975d144c4f97ac5`: an EOA `0x3b47…fc92` executes through
Avalon's Safe, and the pool configurator `0x4bbd637d…7012` emits `ReserveInterestRateStrategyChanged` for USDC,
WETH and FBTC.

```text
[2026-11-06T18:30:38.000Z] RULES CHANGED on Avalon at block 22302862 (tx 0x1e75…7ac5, sent by 0x3b47…fc92 through 0xc6f5…84f4): ReserveInterestRateStrategyChanged USDC, ReserveInterestRateStrategyChanged WETH, ReserveInterestRateStrategyChanged FBTC
                           for 0xd360…e7a0: health 1.7900 -> 1.7900; USDC borrow 3.96% -> 0.01%
                           days left at today's rates over 10 years -> over 10 years; if suppliers leave 3542 days -> over 10 years
                           this doesn't hurt the loan (yet). Who can change these rules: Safe 0xc6f56760f2F4E41095DB8269c5D8380B0fd184F4, 3 of 5 signers, no timelock in front
                           act: nothing needed, health is above 1.50
```

The same replay for the other borrower `0xf5cb…db13` (health 2.8215, same rate drop) is in the file, and so is
the control: block 22302861, one block earlier, "no rule change from Avalon's admin contracts". The timestamp
on these lines is the block's own time, not the time of the replay.

### 4. Watching: alert once, then quiet

[`proof/04-watch-three-rounds.txt`](proof/04-watch-three-rounds.txt): `watch` on three wallets, every 30 s, 3
rounds, console only.

```text
[2026-11-06T22:00:40.423Z] first look: CRITICAL Morpho syzUSD/USDC 0xA4A5…3DCc: health 1.0140 ...
[2026-11-06T22:00:40.425Z] first look: CRITICAL OpenFi 0xf4df…a989: health 1.0403 ...
[2026-11-06T22:00:40.426Z] round 1 at block 22317175: 2 alert(s)
[2026-11-06T22:01:15.742Z] round 2 at block 22317228: 0 alert(s), all as before (Morpho syzUSD/USDC 1.0140 critical, OpenFi 1.0403 critical, Avalon 1.7870 ok)
[2026-11-06T22:01:43.295Z] round 3 at block 22317269: 0 alert(s), all as before (Morpho syzUSD/USDC 1.0140 critical, OpenFi 1.0403 critical, Avalon 1.7870 ok)
```

The Avalon loan at 1.7870 is `ok` and gets no alert. Rounds 2 and 3 also read Avalon's and OpenFi's admin
contracts for blocks 22317176..22317269 and found nothing to report.
