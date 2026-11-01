# tabkeeper: architecture

tabkeeper is the buyer half of an x402 market on Pharos mainnet. The other half, two sellers and their
facilitator, lives in the same folder because Pharos has no public facilitator I could use: the Pharos docs and
the x402-pharos skill both leave the facilitator URL to the user.

```text
   agent (Claude Code + the tabkeeper skill)
     |  task start / catalog / price / buy / retry / task end
     v
   tabkeeper CLI ── ledger.ts (journal.jsonl: tasks, refusals, signed / paid / released payments)
     |      buyer.ts: 402 -> price -> cap + budget check -> sign (EIP-3009) -> send, resend the same payment
     |      wallet.ts: authorizationState(from, nonce), AuthorizationUsed logs, the x402 SDK signer
     |  HTTP: GET -> 402 PAYMENT-REQUIRED, GET + PAYMENT-SIGNATURE -> 200 PAYMENT-RESPONSE
     v
   sellers (seller/server.ts, one process)        mcp.pharosfdv.xyz/x402
     replay.ts: paid answers kept by (payer, nonce)
     @x402/express paymentMiddleware: Harbor data, PROS market
     facilitator.ts: x402Facilitator + ExactEvmScheme (verify, settle), also on /x402/facilitator/*
     |
   Pharos mainnet: USDC 0xC879…1815 transferWithAuthorization, Faroswap V3, Chainlink, Harbor vaults
```

## The sellers

Two sellers, three paid endpoints, prices set in `seller/server.ts`:

| Endpoint | Price | What it returns |
|---|---|---|
| `GET /x402/harbor/yields?amount=N` | 0.002 USDC | the 16 Pharos Harbor assets: realized 7d / 30d yield, TVL, whether a deposit of N passes right now and why not, exit terms, the pick |
| `GET /x402/harbor/positions/:address` | 0.01 USDC | a wallet's holdings in every Harbor venue and its Morpho USDC / WPROS loan |
| `GET /x402/pros/price` | 0.001 USDC | every Faroswap V3 WPROS / USDC pool (mid price, reserves) and the Chainlink PROS / USD feed with its age |

`/x402/health` and `/x402/catalog` are free. The Harbor data is read with harborpilot's adapters (task 11), the
PROS data straight from the pools and the feed. Every answer is a live read of mainnet at one block.

The payment is x402 `exact` with EIP-3009: Pharos USDC has `transferWithAuthorization` and `authorizationState`
(checked on chain: EIP-712 name `USDC`, version `2`). The buyer signs an authorization for exactly the price,
to the seller, valid for 120 seconds, with a random 32-byte nonce. The facilitator checks it and submits it; the
seller's key pays the gas in PROS. The buyer never needs PROS.

A handler that fails returns 502, and `@x402/express` then cancels the settlement: no data, no charge.

## The buyer

### Limits

A task has a budget and a per-call cap (`task start --budget --cap`). Before anything is signed, `ledger.allow`
checks the price from the 402:

- over the cap -> refused;
- over `--max` (what this data is worth to the task, when the agent sets it) -> refused;
- over `budget - spent - held` -> refused. `held` is money in payments that were signed but are not settled yet:
  until the chain says otherwise they may still go through, so they count.

A refusal is written to the journal and nothing is signed. The SDK's own spend control is also set to the cap, as
a second lock in case a bug lets a price through.

### The log

`journal.jsonl` is append-only. A payment is written as `signed` **before** it is sent (with the signed header, so
another run can resend it), then `attempt` rows, then `paid` with the tx hash, or `released`. Totals are derived
from the rows, keyed by nonce: a second `paid` for the same nonce changes nothing. `log` and `task end` print
time, price, running total, tx and what was bought.

### Retries that can't pay twice

The same purchase is only ever one signed authorization. Every retry resends that same header, never a new
signature, and three things make that safe:

1. **The chain**: the USDC contract accepts a nonce once. A second submission of the same authorization reverts.
2. **The seller** (`replay.ts`): an answer that settled is kept under (payer, nonce). The same payment sent again
   gets the same body and the same `PAYMENT-RESPONSE`, without settling again. Two copies arriving at once share
   one settlement. A kept payment used for another URL gets 409.
3. **The buyer's ledger**: counts by nonce, as above.

What happens on each failure:

| What went wrong | What tabkeeper does |
|---|---|
| no answer, timeout, 5xx | waits and resends the same payment (up to `max_attempts`, 4) |
| 402 that names a settlement or RPC problem | resends the same payment |
| 402 rejecting the payment (signature, amount, funds) | stops: the same thing would be rejected again |
| still no data after the last send | asks the chain: `authorizationState(from, nonce)`. Used: the payment is counted once, with the tx found from the `AuthorizationUsed` event, and `retry <nonce>` gets the data from the seller's replay. Not used: the money stays held |
| a held payment's authorization expires unused (plus 30 s for a late settlement) | released: it can never be used any more, so the budget gets it back |

Whether a payment went through is always decided by the chain, not by an HTTP answer. A new payment for the same
data is never signed while an old one could still settle.

## What is tested

`src/tabkeeper.test.ts`, offline, against a seller and a chain in memory with the real rules (a nonce settles
once, a settled nonce gets its kept answer):

- amounts in exact atomic units; the cap, the budget, held money and `--max`;
- a payment reported paid twice counts once;
- only exact Pharos USDC options are picked;
- two endpoints bought in a task, running total and tx hashes in the log;
- over the cap and over the budget: refused, nothing signed;
- a lost answer after settlement, a 500 and a dropped request: resent with the same nonce, one signature, one
  settlement, counted once;
- every send lost but the chain shows the payment: counted once, `retry` gets the data with no new charge;
- never reached the seller: held, refused while held, released after expiry;
- a payment the seller rejects is not resent;
- the seller replay: same payment twice (also at once) answered once, a second URL refused with 409.
