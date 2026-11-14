---
name: prosperion
description: >
  Prosperion: what is really behind a Prosper vault on Pharos mainnet, and whether a new Prosper launch is genuine
  and still untouched. Use it when someone asks about a Prosper vault's NAV, why it moved, how much of it can be
  checked on chain, how stale its prices are, how the early depositor reward unlocks, or wants to buy into a new
  Prosper market first through the Prosperion gate. Read-only: it uses no key and signs nothing; the person signs
  in their own wallet on the Prosperion page.
version: 1.0.0
requires:
  mcp:
  - prosperion
  - pharos-chain
---

# Prosper, as read from the chain

## Where things live

- Addresses come from Prosper's API (`https://api.pros-per.xyz/api/v1/deployment`) and are trusted only after
  `protocol_map` checks them: the factory must be `0xEfdbb0eA7647B0e21AEf7A3b7a5D6A632c3116C8`, the market beacon
  must be the one real markets point at, and every address must have code.
- Each vault is an R25 `CoreVaultAsync` (ERC-7540 style, USDC in, async settle). Around it: ShareToken, Escrow (holds
  the assets), Accountant, NAV oracle, AdapterRegistry, adapters, policy router, fee router.

## NAV, honestly

- NAV = USDC and tokens in the escrow on Pharos + Local adapter positions on Pharos + Mirror adapter value.
- A Mirror adapter is 1.0 unit of a made-up asset whose price the operator pushes. It is a number you take on trust.
  `vault_picture.verifiableBps` is the share you can check on Pharos. Examples read on chain: Barker Neutral Carry
  89% (block 22652603), EM Lockhart Edge under 0.1%.
- Prices come from one shared off-chain price oracle with a 180 s max age, but updates arrive hours apart, so the
  oracle usually calls its own NAV stale (`validNav:false`). The vault reads NAV in "allow stale" mode anyway.
- `vault_picture.reconciles` is true when our sum of the parts equals the oracle's figure to the last unit. If it is
  false, say so and do not explain the gap.

## Why NAV per share moved

`nav_move` splits a move between two blocks (at most 50,000 apart):
- flows: deposits or redeems settled (assets and shares moved in the same block);
- admin: shares burned with no money moving. Example: Barker, block 22652604, 593.83 shares burned, assets unchanged,
  NAV per share 1.072857 -> 1.078977 (+0.57%). Not trading;
- fees: shares minted with no money moving;
- mirror: the operator-reported value changed;
- price: whatever is left of the asset change.

## Deposits and exits

- Deposit: approve the vault for the exact USDC amount, then `requestDeposit(assets, you, you)`. The operator settles
  later (one observed case: about 13 hours). Prosper's own app asks for an unlimited approval; Prosperion never does.
- Exit: `requestRedeem(shares, you, you)`, one transaction, settled later the same way.

## Launches (pVaults)

- Every market comes from Prosper's factory. Genuine means `factory.deploymentOf(market.r25Vault()).market == market`.
  `market_check` does this and never throws on a bad address.
- Phase 0 = on the curve, 2 = graduated, 3 = failed. Graduation needs 20,000 PROS in the curve within 14 days.
  1B supply: 73% curve, 20% FaroSwap, 6% early depositors, 1% curator. Trading fee 1% each way; half of it went to the
  vault's curator in the buy we traced.
- The curve is constant product on virtual reserves. Buying and selling back with nobody else trading returns
  98.01 of 100 PROS: two 1% fees.
- `reserveBefore` is the PROS already in the curve; 0 means nobody bought yet. In the history we checked nobody
  bought in the creation block or the next one; the fastest first buys came 2 blocks later.

## The Prosperion gate

`buy(market, minOut, deadline)` checks, in one transaction: limits set, genuine market, phase 0, reserve at or under
your `maxReserveBefore`, market code equal to the one you accepted, amount within per-buy and per-day limits. Then it
calls the market's `buyNative` with you as the recipient: the tokens go straight to you (verified on a mainnet fork).
It holds nothing and has no owner. Refusals: NoLimits, NotGenuine, WrongPhase, NotFirst, ImplChanged, OverPerBuy,
OverPerDay.

## Early depositor reward

`reward_unlock` gives the unlock table and current step from Prosper's API and NAV per share from the chain. The
table is measured on a 7-day NAV median and the reward weight formula is not on chain: always call it a hypothesis.

## Cross-check

Before stating a vault's total assets or a market's reserve, read the same value through the pharos-chain `eth_call`
tool at the same block and say it matched. For a vault, vault_picture returns `crossCheck`: each entry is the exact
`to`, `data` and `block` to pass to `eth_call` and the value it must return. Copy them as they are; never work out a
function selector yourself.
