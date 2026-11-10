# 24 · Audit-Log Agent

**tieout** is an agent skill that writes a plain-language activity report for any Pharos mainnet wallet over a
period: the kind of statement a compliance officer or an accountant can read. You give the agent an address and a
date range. It sorts every transaction into transfers in, transfers out, swaps, approvals, contract interactions and
failed ones, totals each category, picks out the transactions worth a second look (with explorer links) and exports
the whole thing as Markdown, CSV and PDF.

The name is the point. In accounting, a statement "ties out" when the opening balance plus everything that came in
minus everything that went out lands exactly on the closing balance. A list of transactions from an explorer can
look complete and still miss things, so tieout checks it, per token, to the last unit:

```
opening balance (read on chain at the last block before the period)
  + every incoming amount in the period
  - every outgoing amount in the period
  - gas the wallet paid
  = closing balance (read on chain at the last block of the period)?
```

When it holds, the report says so. When it doesn't, the report shows the gap and its size instead of hiding it. On
a real OpenFi borrower that caught interest accruing on a deposit and on a loan, with not a single transaction in
the period (see [Proof](#proof)).

Read-only: no key, no `.env`, nothing is signed or sent.

## Quick start

```bash
cd 24-tieout && npm ci && npm run build && npm test
node skill/tieout/scripts/tieout.mjs report 0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb \
  --from 2026-11-01 --to 2026-11-10T18:00 --tz UTC --out reports
```

- `--from` / `--to`: a whole day (`2026-11-01`) or a moment (`2026-11-10T18:00`). Both ends are included.
- `--tz`: the zone the dates are in, `UTC` or an offset like `+03:00`. The report prints times in that zone.
- `--format md,csv,pdf`: any subset, all three by default.

The skill is `skill/tieout/`: SKILL.md plus one bundled script, so the user needs nothing but node. SKILL.md tells
the agent what to ask (address, period, time zone), how to run it, and how to retell the result: books first, then
totals, then the second look.

## Where every number comes from

| What | Source |
|---|---|
| Which transactions touched the wallet | socialscan explorer API, used only as an index |
| Token amounts | the `Transfer` logs in each transaction's receipt (exact units, not the explorer's decimals) |
| Wrapped PROS | `Deposit` / `Withdrawal` logs, counted only when the same amount of PROS went in or came out |
| Native PROS | transaction value plus internal calls |
| Gas | `gasUsed * effectiveGasPrice` from the receipt |
| Opening and closing balances | `eth_getBalance` and `balanceOf` at the two edge blocks |
| Allowances left at the end | `allowance(owner, spender)` at the closing block |
| Period to blocks | binary search over block timestamps |

Why an index at all: the Pharos RPC answers `eth_getLogs` for 1,000 blocks at most, and it makes roughly one block a
second. One week would be some 600 log queries per token. So the explorer says which transactions to look at, the
chain says what they did, and the tie-out tells us if the explorer left something out.

## Categories

- **Transfers in / out**: money to or from other wallets. That includes a batch payout through a contract and a
  payment someone else submitted on the wallet's behalf (an x402 seller pulling a signed USDC authorization, for
  example). The report names who sent the transaction in that case.
- **Swaps**: one asset out, another in, and a Uniswap V2 or V3 `Swap` event in the same receipt. Change the router
  sends back is netted out, so you read "swapped 0.0087 PROS for 1 pTACO", not two separate movements.
- **Approvals**: `approve`, `increaseAllowance`, `decreaseAllowance`, `permit`. Approval events that a router fires
  while spending an allowance inside a swap or a deposit are not counted as the user approving something.
- **Contract interactions**: everything else the wallet called: deposits, withdrawals, wraps, claims, with what went
  in and out.
- **Failed transactions**: reverted. Nothing moved, but gas was paid, and the report says how much.

## Worth a second look

The report doesn't just list. It flags, with a reason and a link:

- an asset that doesn't tie, and by how much (debt tokens get their own wording: what the wallet owes grew);
- failed transactions and the gas they burned;
- unlimited approvals, and approvals that are still open at the end of the period (with what's left);
- the first payment ever to an address, and the first call ever to a contract, judged against the wallet's whole
  history before the period;
- the largest single movement per asset, when there was more than one to compare.

## Exports

- **Markdown**: summary, the "Does it add up" table, totals by category, the second look, approvals, then every
  transaction by category in one plain sentence each, all linked to pharosscan.
- **CSV**: one row per movement of money, so `SUM` over a column gives the report's totals. Gas sits on a
  transaction's first row only, so summing it doesn't count a fee twice. A second file, `-books.csv`, holds the
  tie-out with both edge blocks in every row.
- **PDF**: the same content, A4 landscape, with clickable links. It's written by a small PDF writer in
  [`src/pdf.ts`](src/pdf.ts) that uses the standard PDF fonts. The usual PDF libraries read font files from disk at
  runtime, and the bundled skill doesn't carry those.

Every report ends with a fingerprint: a hash of both CSV files. The same wallet and period give the same
fingerprint, so someone can rerun a filed report and compare.

## Proof

All runs were made against Pharos mainnet on 2026-11-10. Everything is in [`proof/`](proof/).

### 1. Our test wallet, 1 Nov to 10 Nov 18:00 UTC: everything ties

[`proof/01-run.txt`](proof/01-run.txt) is what the agent sees. The report itself:
[Markdown](proof/tieout-46441d-2026-11-01-to-2026-11-10.md),
[CSV](proof/tieout-46441d-2026-11-01-to-2026-11-10.csv),
[books CSV](proof/tieout-46441d-2026-11-01-to-2026-11-10-books.csv),
[PDF](proof/tieout-46441d-2026-11-01-to-2026-11-10.pdf).

This is the wallet our earlier tasks ran from, so the period is busy: blocks 21807390 to 22676031, 64
transactions it sent itself and 18 sent by others.

- By kind: 3 transfers in, 44 transfers out, 1 swap, 6 approvals and 28 contract interactions.
- The books tie for all 8 assets: PROS, USDC, pCARR, pTACO, pMusk, sbUSDC-ph-eco, Wrapped PROS and APT.
- Approvals went to 4 token and spender pairs. One is still open at the end: USDC to Morpho, 0.000006 left.
- The second look picks out, among others: the x402 seller of task 12 pulling 0.001 USDC authorizations, the task 15
  airdrop that paid ten new addresses in one transaction (first payment ever to each), and the bookkeeper payouts
  of task 23 on 10 November.

Fingerprint `d4bd87708ca2307c`. A second run gave the same fingerprint and a byte-identical CSV.

### 2. The same report, re-checked without tieout's code

[`tools/recheck.mjs`](tools/recheck.mjs) uses only `fetch` and the two CSV files. For every asset in the books file it
reads the opening and closing balance at the blocks written in the file, and it re-adds the transactions file to see
that the in, out and gas columns match. [`proof/02-recheck.txt`](proof/02-recheck.txt):

```text
all 8 assets agree with the chain and with the transactions file
```

### 3. A real borrower where the books don't tie, and why

`0xF4DFDD6407a63A36bD26af92b593E7fdC913A989` holds a position on OpenFi (an Aave fork on Pharos). Its report for
1 to 9 November ([`proof/03-run.txt`](proof/03-run.txt),
[Markdown](proof/tieout-f4dfdd-2026-11-01-to-2026-11-09.md),
[PDF](proof/tieout-f4dfdd-2026-11-01-to-2026-11-09.pdf)):

```text
Nothing touched this wallet in the period.
The books do NOT fully tie: 3 of 19 assets have a gap between what the transactions explain and the closing balance on chain
  variableDebtUSDC: 4.59174 variableDebtUSDC -> 4.595352 variableDebtUSDC  OFF by 0.003612 variableDebtUSDC
  bUSDC: 6.070607 bUSDC -> 6.073345 bUSDC  OFF by 0.002738 bUSDC
  bWPHRS: 0.100025044899776191 bWPHRS -> 0.100034434904670076 bWPHRS  OFF by 0.000009390004893885 bWPHRS
```

The other 16 assets (PROS, USDC and LP tokens) tie. [`proof/05-gap-tokens.txt`](proof/05-gap-tokens.txt)
asks the three tokens who they are: "OpenFi USDC", "OpenFi WPHRS" and "OpenFi Variable Debt USDC". All three answer
`POOL()` with the same OpenFi pool `0x30B2E1411FD2ed9F1f46f59497e2186cE5BE3b26`. The deposit grew and the debt grew,
with no transaction at all. That is the case a plain transaction export gets wrong: it would show this wallet as
untouched, and it would be off by real money. [`proof/04-recheck.txt`](proof/04-recheck.txt) confirms the balances
from the chain: all 19 assets agree, and the books file says `ties=no` for the same three.

### 4. Tests

`npm test`: 15 tests on a fake wallet that has every category in one period. They check that the router's change is
netted, that Approval events inside a deposit don't count as approvals, that a balance moved without a transfer
breaks the tie by the exact amount, that a look-alike `Deposit` event isn't taken for a wrap, that a throttled RPC is
retried and a revert isn't, and that the PDF's cross-reference table points at every object.

## Things the real data taught us

- Wrapped PROS emits `Deposit` and `Withdrawal`, never `Transfer`, when you wrap and unwrap. The first version missed
  those flows, and on our wallet the books still tied by luck: two wraps and two unwraps of 0.05 each cancelled out.
  Now a wrap counts only when the same amount of native PROS went into that same contract in that transaction.
- The public RPC answers `cu limit exceeded; Request too fast per second` (code -32011) under load, and viem doesn't
  retry it. tieout waits and asks again. A token whose `balanceOf` keeps failing for that reason is reported as an
  error, never as a zero balance.
- The explorer gives some tokens the same symbol as native PROS (Wrapped PROS) and ten pools the same name
  ("Uniswap V2"). The report labels them by full name, and by address when even the names repeat.

## Limits

- The explorer lists at most 10,000 rows per kind. For a wallet with more, the "first payment / first call" checks
  are skipped and the summary says so. The tie-out still runs.
- Approvals are read from transactions the explorer lists for the wallet. A `permit` signature that someone else
  submitted shows up only if the explorer lists that transaction for the wallet too.
- No prices. Amounts are in the tokens themselves.
- NFTs are not part of the tie-out.
- Swaps are recognised by Uniswap V2/V3 `Swap` events. A buy through a contract that emits no such event (the two
  pMusk buys in the proof) shows up as a contract interaction, with what went in and what came back.
