---
name: tieout
description: >
  tieout: writes a plain-language activity report for any Pharos mainnet wallet over a period, the kind of summary a
  compliance officer or an accountant can read. Give it an address and a date range; it sorts every transaction into
  transfers in, transfers out, swaps, approvals, contract interactions and failed ones, totals each category, lists the
  transactions worth a second look (failed ones, unlimited or still-open approvals, the first payment to a new
  address, the biggest movements) with explorer links, and exports Markdown, CSV and PDF. Then it checks the books:
  for every token the opening balance plus what came in minus what went out (and gas) has to equal the closing
  balance read from the chain at the period's last block. If it doesn't, the report shows the gap instead of hiding
  it. Read-only: no key, nothing signed, nothing sent. Use when someone asks what a wallet did over a period, wants
  an audit log, statement, activity report or export of a wallet's history on Pharos.
version: 1.0.0
requires:
  anyBins:
  - node
---

# tieout

`node scripts/tieout.mjs report <address> --from <date> --to <date> [--tz <offset>] [--out <dir>] [--format md,csv,pdf]`
(below just `tieout`). It needs nothing but node: no install, no key, no `.env`.

## What to ask first

You need three things. Ask only for what the user didn't say, one short question at a time.

1. **The wallet address** (0x + 40 hex characters). Any address works, not only the user's own.
2. **The period.** Whole days (`2026-11-01`) or exact moments (`2026-11-10T18:00`). Both ends are included.
3. **The time zone the dates are in.** If they name a city, turn it into an offset yourself (Moscow is +03:00,
   Berlin is +01:00 in winter). If they don't care, use UTC and say so.

Formats default to all three (Markdown, CSV and PDF). Ask only if the user mentions one in particular.

## Running it

- `tieout report <address> --from <date> --to <date> --tz <offset> --out <folder>`. Put the files in a folder the
  user can find, for example `./reports`.
- A busy wallet takes a while: it reads every receipt in the period. Progress lines go to stderr. Don't stop it.
- If it fails, tell the user the error line as it is. Don't guess the numbers yourself.

## Telling the user what came out

stdout has four blocks: SUMMARY, DOES IT ADD UP, TOTALS BY CATEGORY, WORTH A SECOND LOOK, then the file paths.

1. Start with the books. If every asset says `ties`, say that the opening balance plus what came in minus what
   went out equals the closing balance on chain for every token, so nothing is missing. If one is `OFF by`, say so
   first and explain what the report says: the balance moved without a transfer the explorer listed (an
   interest-bearing or rebasing token, or a missed transaction). Never round a gap away.
2. Then the totals in a sentence or two: how many transactions of each kind and the main amounts.
3. Then the second look, in plain words, with the links. An unlimited approval that is still open is the one a
   compliance reader cares about most. Say which token and which spender.
4. Finish with where the files are. If they want details, read the `.md` file and answer from it. Quote only
   numbers that are in the output or the files.

## What each category means

- **Transfers in / out**: money that went to or came from other wallets, including a batch payout through a
  contract and a payment someone else submitted on the wallet's behalf.
- **Swaps**: one asset out, another in, in a transaction where a DEX pool emitted a Swap event. The router's change
  is netted, so "swapped 0.0087 PROS for 1 pTACO" is the real price.
- **Approvals**: approve / permit calls. The report also checks the allowance at the closing block, so it can say
  which ones are still open.
- **Contract interactions**: everything else the wallet called (deposits, withdrawals, claims, wraps), with what
  went in and out.
- **Failed transactions**: reverted. Nothing moved, but the gas was paid.

## Limits worth saying out loud when they matter

- The explorer is the index of which transactions touched the wallet. It lists 10,000 rows per kind at most. On a
  wallet with more than that, the "first payment to a new address" check is skipped, and the summary says so.
- No prices: amounts are in the tokens themselves, never converted to dollars.
- NFTs are not part of the tie-out.
