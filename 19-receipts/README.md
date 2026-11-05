# 19 · Portfolio Assistant

**receipts** is an agent skill that answers plain questions about one Pharos wallet: what it holds, where a
token sits, what it is all worth, how a token trade went, what its vaults and staking earned, which vault
requests have not paid out yet. Every number in an answer carries a fact id, and every fact names the contract,
the call or the transaction, and the block it was read at. When receipts can't know something, it says why.

It does not scan the chain block by block. It takes the wallet's own history from the Pharos explorer
(transactions, token transfers, internal transfers), then reads every amount and every price on chain through
the Pharos Chain MCP, all at one pinned block. It is read-only: there is no signing code in it at all.

How it works, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## Quick start

```bash
cd 19-receipts && npm ci && npm run build
node skill/receipts/scripts/receipts.mjs scan 0xYourWallet
node skill/receipts/scripts/receipts.mjs holdings
node skill/receipts/scripts/receipts.mjs pnl pTACO
```

The skill itself is `skill/receipts/` (SKILL.md plus one bundled script, no install, no keys). An agent that
loads it scans first, answers in plain words with the fact ids, and runs `check` on its draft before replying.

| Command | The question it answers |
|---|---|
| `scan <wallet>` | read the history and every position at one pinned block (always first) |
| `holdings` | what does it hold, in the wallet and inside protocols, and what is it worth |
| `where <symbol>` | where is my USDC (wallet, vaults, pools, pending requests) |
| `biggest` | what are the biggest positions |
| `total` | what is it all worth, and what had to be left out |
| `pnl [symbol]` | what did I pay, what did I sell for, what did I make |
| `earning` | what are my vaults and staking earning |
| `protocols` | which protocols hold my money, which contracts have I used |
| `inflight` | which deposit or redeem requests haven't paid out yet |
| `facts [F..]` | the fact table |
| `check <file\|->` | does every number in this answer carry a fact id and match it |

## Where the numbers come from

- **Holdings.** Every token the wallet ever touched gets `balanceOf` at the pinned block (Multicall3, in
  batches), plus native PROS. Shares are opened up: ERC-4626 vaults through `convertToAssets`, ERC-7540 vaults
  through their `share()` and `convertToAssets`, V2 pool shares through the pair's reserves, Morpho Blue
  positions through `position` and the market totals. Deposit and redeem requests found in the history are read
  with `pendingRedeemRequest` / `claimableRedeemRequest` (and the deposit ones) for their request id.
- **Prices.** PROS from the Chainlink PROS/USD feed. Other tokens through their Prosper V2 pool against WPROS,
  through the Prosper curve market's `quoteSell` while a token is still on its curve, or through the vault they
  are a share of. USDC is a dollar. Prices at a past block (for a buy or an arrival) are read at that block.
- **Trades.** The explorer says which transactions to look at; the amounts come from each transaction's receipt
  on chain. Native PROS paid by a router comes from the explorer's internal transfers. Cost is the average price
  paid; a sale is taken out of what was bought first.
- **Completeness.** The explorer sometimes serves fewer rows than it says exist. receipts says so, with the
  counts as facts, and before giving any profit figure it checks that a token's history adds up to its balance
  on chain. If it doesn't, there is no profit figure for that token, only the reason.

## When it can't tell

"I don't know" is never the whole answer. Every gap has one of these reasons, in plain words:

| Reason | What it means |
|---|---|
| `received-not-bought` | the token came in by transfer; this wallet never paid for it, so its real profit can't be known here. Only the price change since it arrived is shown, and it is not earnings |
| `history-incomplete` | the explorer's history doesn't add up to the balance on chain |
| `no-cost-basis` | there is a balance but no incoming history that shows what it cost |
| `no-price-route` | there is no pool on chain to price it through |
| `no-adapter` | the wallet sent money to a contract receipts does not know how to read |
| `read-failed` | the contract is known, but the read reverted or timed out |
| `explorer-chain-mismatch` | the explorer and the transaction receipt disagree; the chain's number is used |
| `explorer-unreachable` | the explorer did not answer |

## What an answer looks like

From a run on 2026-11-05 at block 22206146, wallet `0x9f85...a37c` (fact table trimmed):

```text
pTACO (0x52acdeb49056518578c7af788ae2c367132e2db5): 0 held now [F20]
  block 18445681: bought 7349.089208 pTACO for $29.9117, tx 0xd5bbf36e...ecdac [F22]
  block 18446703: sold 7349.089208 pTACO for $30.6609, tx 0xc4de9778...c2767 [F24]
  ...
  block 19575529: received 5506.30366 pTACO from 0x1584...6811 (nothing paid in that tx), tx 0x606bd7be...d2f19 [F32]
  block 19575665: sold 5506.30366 pTACO for $36.4537, tx 0x5523e777...685d [F34]
  ...
  price now: $0.00450831 per pTACO [F43]
  average price paid: $0.00412579 per pTACO [F44]
  realized on sales: $4.09036 [F45]
```

And the answer checker on two drafts:

```text
$ echo 'You realized $4.09036 on pTACO [F45]' | receipts check -
OK: every number in the answer carries a fact id and matches it.
$ echo 'You realized $9 on pTACO [F45]' | receipts check -
NOT OK:
  - line 1: $9 does not match F45 (4.090359208)
```

## Limits

- History is only as complete as the explorer's. A gap is reported, and profit is withheld for a token whose
  history doesn't add up to its balance, but a missing row is not recovered.
- Contracts without standard getters are listed as `no-adapter` with the money that went in; their positions
  are not read.
- Prices are spot prices from the pools at the block, not a time-weighted average. For thin pools that matters.
- Cost is in USD at the block of each trade, so profit includes PROS's own price move over the period.

## Tests

`npm test`: 55 tests on a scripted Chain MCP and a scripted explorer, plus real transactions and receipts saved
from mainnet: explorer paging and gaps, receipts against explorer rows, holdings for every share kind, pricing
routes, average cost and realized profit, received tokens, half-answered vault requests, the answer checker, and
a check that the source has no signing or sending code.

## Proof

Filled in after the recorded agent session.
