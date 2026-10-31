# harborpilot: architecture

harborpilot puts the 16 assets listed on [Pharos Harbor](https://port.pharos.xyz/harbor) behind one interface.
They come from eight protocols with four different contract shapes, so the work is mostly in reading each of them
the same way and then deciding fairly.

```text
            CLI / agent skill  (venues, best, positions, deposit, withdraw, claim, borrow, repay)
                         |
         +---------------+------------------+
         |                                  |
     router.ts  (pure)                  exec.ts
     conditions + quotes                plan check (step by step, with state overrides)
     -> ranking, pick, why,             send (re-simulate, sign, receipt, stop on failure)
        why-not for each venue              |
         ^                                  |
         | quotes (one per venue, each with its own deadline)
         |                                  |
     adapters.ts                        morpho.ts
     vault-v2 | r25-sync | r25-async     USDC / WPROS market: state, loan,
     full-async | accountable | epoch    borrow and repay steps
     ember | centrifuge | token-only
         |                                  |
     venues.ts  (16 Harbor assets -> contract, kind, Harbor's own terms)
         |
     chain.ts  (one pinned block, paced JSON-RPC with retry, eth_call with state overrides, revert decoding)
         |
     rpc.pharos.xyz  (Pharos mainnet, chain 1672)
```

## Venues

`venues.ts` maps every Harbor asset to its contract on Pharos and to a kind. I found the contracts by scanning
the whole chain history for vault events (Morpho market and Vault V2 creation, ERC-4626 and ERC-7540 deposits
and requests, Centrifuge share classes, Aave reserves) and checking each candidate with `eth_getCode` and reads.
Three of the 16 have no deposit contract on Pharos (Vishwa ETHvp and BTCvc are tokens a minter issues, BitFi
bfBTC has no underlying asset set), and for BTCvp I found no contract on Pharos. They stay in the list, read-only, so
the user sees why they are never picked.

What the registry does **not** decide: whether a venue is open. That is checked live on every run (below).

## Queries

A quote for a venue (`adapters.ts` `quote`) is read at one pinned block (head minus one, so every node behind
the load balancer has it):

- **Yield**: the share price (`convertToAssets` of one share) now, about 7 days ago and about 30 days ago
  (archive reads), annualized from the real block timestamps. This is the yield the vault actually paid, after
  its fees, not the advertised target.
- **TVL**: `totalAssets`, except Accountable, where `totalAssets` is only idle cash and the value is
  `convertToAssets(totalSupply)`.
- **Open or not**: the deposit itself, simulated with `eth_call` from the user's address, with a state override
  that gives it the USDC and the allowance. If it passes, the venue takes this exact deposit right now. If it
  reverts, the decoded revert is the reason: below the minimum, paused, whitelist, KYB membership, a closed
  epoch. This one check covers caps, pauses and gates that each protocol exposes differently. For two cases
  the revert says too little, so the adapter reads the state behind it: an epoch vault's `isLocked()` and a
  Centrifuge vault's `maxDeposit(user)`.
- **Exit**: per kind. Morpho Vault V2 pays out at once up to its free liquidity: idle USDC plus the free
  liquidity of the Morpho market its liquidity adapter points to. R25's 1D vault unlocks shares after
  `maturityPeriod` and has a daily per-wallet quota. The 6M vault's requests mature after `maturityPeriod`
  (184 days) and cost `nativeFee` in PROS. Axil Pot charges `redeemFeeBps`. Where the chain has no schedule
  (requests an operator fills), the adapter uses Harbor's stated liquidity terms and says that it comes from
  Harbor.

Positions (`position`) read the user's shares and value in every venue and, for request vaults, the ERC-7540
pending and claimable amounts. The Morpho loan is read from `position(id, user)` and converted to debt with
Morpho's own rounding.

## Routing

`router.ts` is a pure function: quotes and the user's conditions in, a ranking and reasons out. It doesn't touch
the chain, so the same quotes always give the same answer and it can be tested on its own.

1. A venue is left out, with the reason, if: it doesn't take the deposit now (the revert), the amount is below
   its minimum, Harbor marks it as not for the user's region, its deposit is a request and the user wants it
   filled at once, the money comes back later than the user can wait, more than its free liquidity would have to
   leave, it has no yield history, or (with `--stable`) its share price fell over 7 or 30 days.
2. The rest are ranked on the **lower** of the 7-day and 30-day realized yield. One good week shouldn't win
   over a steady month, and a vault whose price moves both ways is judged on its worse window.
3. An exit fee is spread over the user's horizon (default 90 days) and subtracted.
4. The pick comes with the numbers behind it and the gap to the next venue; every other venue gets its own
   line saying why it lost or was left out.

## Actions

Every action is a list of unsigned transactions (`Step`): approve then deposit, approve then deposit request,
redeem, redemption request (with the PROS fee as value where the vault asks for one), claim, and for the loan
wrap PROS, approve WPROS, post collateral, borrow (and the reverse for repay).

Before anything is signed the whole plan is simulated, each step on top of what the earlier ones leave behind.
The Pharos RPC has no multi-transaction simulation (`eth_simulateV1` isn't available), so each step declares its
effect as a state override: the allowance an approve sets, the WPROS a wrap mints, the collateral that
`supplyCollateral` writes into Morpho's `position` slot. I found the storage slots by writing a slot in an
override and reading it back (USDC balance and allowance at mapping slots 9 and 10, WPROS at 3 and 4, Morpho's
position at slot 2 with collateral in the upper 128 bits of the second word). So `borrow` is checked against
Morpho's real oracle and health check before the collateral exists.

Without `--yes` that is all: the plan is shown with OK or FAILS and the reason. With `--yes`, `exec.ts` takes
the steps one at a time: simulate again on the live chain, estimate gas, sign with the key from `.env`, send,
wait for the receipt (its own polling, with the nonce counted locally, because right after a receipt a node
behind the load balancer can still report the old nonce). The first step that would fail or did fail stops the
run, and the output says what was sent and what wasn't.

Limits: `max_usdc_per_deposit` (100) and `max_ltv` (30% of the collateral's value; the market liquidates at
38.5%), checked before the plan is built.

## When a protocol is down

Every venue is quoted in its own promise with its own deadline (`venue_timeout_ms`, 25 s), all at once, through
`Promise.allSettled`. A venue that throws or doesn't answer in time becomes `status: "down"` with the reason; the
router lists it under "didn't answer" and compares the others without it. `positions` does the same per venue.

Underneath, `chain.ts` keeps the RPC usable: at most 6 requests in flight, reads batched through Multicall3, and
a retry with backoff when the node throttles. Pharos' RPC answers a burst with
`-32011 cu limit exceeded; Request too fast per second`, a code viem doesn't retry on its own. A revert is never
retried; it goes straight back as the reason.

## What is tested

`src/harborpilot.test.ts`, offline: the ranking and every exclusion rule; a venue that hangs and one that throws
while the other 14 answer; revert decoding against the selectors seen on chain; the override slots; the
transactions each kind builds; the plan check applying each step's effect to the next; loan math; the RPC
retry on a throttled answer and no retry on a revert.
