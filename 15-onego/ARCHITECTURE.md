# onego: architecture

```
plain words --(agent, SKILL.md)--> plan.json --> check --> table for the user --(user says send)--> send --> tx + outcome
```

| File | Job |
|---|---|
| `src/plan.ts` | validates a plan: addresses, amounts counted exactly (never rounded to zero), no paying one address twice or the wallet itself, and a plain "no" for anything that would need an approve |
| `src/book.ts` | addresses, storage slots and ABI bits, all checked on mainnet |
| `src/chain.ts` | the only door to the chain: JSON-RPC with a nap on the public node's rate limit, plus tapes |
| `src/market.ts` | where a Prosper token trades (walks the V2 factory's pair list, since it has no working `getPair`; or a known curve market) and the quote |
| `src/recipients.ts` | the latest plain wallets: distinct senders from recent blocks with no code at all |
| `src/batch.ts` | the plan as Multicall3 calls, USDC signatures, and read-backs |
| `src/check.ts` | the simulation and the per-action results |
| `src/verdict.ts` | the send-or-not rules |
| `src/baseline.ts` | the same actions estimated one transaction at a time |
| `src/report.ts` | the table a person reads |
| `src/send.ts` | fresh check with real signatures, one signed transaction, then what really happened; `cancel` |
| `src/store.ts` | the data folder and the key in `.env` |
| `src/cli.ts` | the commands; bundled into `skill/onego/scripts/onego.mjs` |

## The simulation (`check.ts`)

1. Resolve and quote every buy. A curve buy sends exactly `quoteBuy().usedGross`.
2. Mirror the wallet's money: the wallet gets its real PROS (or the "what if" amount) as a balance override.
   USDC payments are signed by a throwaway key that gets the wallet's real USDC (storage slot 9) and **no code**:
   some well-known test keys' addresses are EIP-7702 delegated on Pharos, and USDC then checks the signature
   the contract way and refuses it. Real signatures are made only by `send`.
3. One `eth_call` of the read-backs alone (balances before), one of actions plus read-backs (results and
   balances after). If the batch reverts as a whole, a rerun with every step allowed to fail finds the step
   that broke and its reason.
4. Refuse (`verdict.ts`) when any action fails, a PROS recipient has code, Multicall3's balances would grow
   (the change, so dust parked there earlier doesn't block anyone), a buy would deliver less than quoted, the
   gas can't be estimated or is over 30,000,000, or the wallet's PROS or USDC can't cover it. A curve market
   given in the plan must sell the token the plan names.
5. Gas is estimated for exactly the calldata `send` will broadcast (the actions, without the read-backs).

## Sending (`send.ts`)

`check` again with the wallet as the signer; stop if anything fails (its signatures are then listed for
`cancel`, since the node has seen them). Sign a type-2 transaction to Multicall3 (fee cap 2x the node's gas
price, 1 gwei tip, gas = estimate x 1.2), write its hash and signatures to `sends/<hash>.json`, then send and
wait up to 60 s for the receipt. Ask USDC `authorizationState` for every payment, then measure the outcome:
tokens from the receipt's own Transfer events (a balance read later would also count whatever else reached the
recipient in the meantime), PROS by reading the balances again. Any growth in Multicall3's holdings is
reported loudly.
`cancel` voids unused signatures (`cancelAuthorization`, one transaction) and only says so after checking the
receipt and that every signature now reads as used.

## Tests without a network

`chain.ts` can wrap the real node and write every question and answer to a tape; `fromTape` answers only from
it and throws on anything else. `test/record-tapes.mjs` records the scenes with a fixed throwaway key, clock and
nonces, so the replay asks exactly the same questions.
