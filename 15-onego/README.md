# 15 · Batch Executor

**onego** is an agent skill that does several things on Pharos mainnet in **one transaction** from a plain
wallet, and **gives nobody any rights to that wallet**: no `approve`, no `permit` to a middleman, no EIP-7702
delegation. Ask the agent in plain words ("airdrop 0.00001 USDC to the 10 latest real wallets", "buy pTACO,
pCARR and pMusk for 5 PROS each"): it turns that into a plan, simulates the whole batch on mainnet, shows what
each action would do and how it compares with sending them one by one, and sends only when the user says so.

How it works, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md). Design notes:
[docs/superpowers/specs/2026-11-03-onego-design.md](../docs/superpowers/specs/2026-11-03-onego-design.md).

## Why "nobody gets rights" matters

The usual ways to batch from a wallet hand someone power over it. Approving tokens to Multicall3 lets anyone who
calls Multicall3 take them: Multicall3 makes whatever call it's told to, `transferFrom` included. Delegating the wallet through EIP-7702 hands
its code to a contract, and on Pharos mainnet we found wallets delegated to an unknown farm operator's contract,
plus well-known test keys whose addresses are delegated already. onego uses only what the wallet can do without
trusting anyone:

| Action | Inside the one transaction | Why nobody gets rights |
|---|---|---|
| Send PROS | Multicall3 calls the recipient with `value` | the PROS rides along with the call |
| Send USDC | `USDC.transferWithAuthorization` (EIP-3009), one off-chain signature per payee | each signature can only pay that amount to that address, for 15 minutes |
| Buy a graduated Prosper token | wrap PROS to WPROS, pay the V2 pool, `pair.swap(out, to = wallet)` | Multicall3 only spends the WPROS it minted a moment earlier; tokens go straight to the wallet |
| Buy a Prosper token on its curve | `market.buyNative(minOut, deadline, recipient = wallet)` | the market pays the wallet directly (the router's buy would pay Multicall3, so onego skips it) |

Every batch ends with read-backs in the simulation: who holds what afterwards, Multicall3 included. If
Multicall3 would keep anything at all (a token, WPROS, PROS), onego refuses to send.

## Two runs on Pharos mainnet

Both simulated on mainnet state on 2026-11-03 (`onego check`, with "what if" balances), replayed by the tests
from recordings of the chain's answers in `test/tapes/`.

| Run | Actions | Transactions | Gas: one by one → batch | Left in Multicall3 |
|---|---|---|---|---|
| Airdrop 0.00001 USDC to the 10 latest plain wallets | 10 | 10 → 1 | 776,403 → 865,320 (**+11.45%**) | nothing |
| Buy pTACO, pCARR, pMusk for 5 PROS each | 3 | 7 → 1 | 608,791 → 488,789 (**-19.71%**) | nothing |

Said plainly: the buys save gas, because one transaction replaces seven and their fixed costs. The airdrop
saves steps but costs more gas: a USDC payment by signature checks the signature and stores its nonce, which a
plain `transfer` doesn't. onego prints whichever way it goes.

"One by one" is what the wallet would send without a batcher, each estimated by the node: a USDC or PROS send
is one transaction, a curve buy is one (`buyNative`), a pool buy is three (wrap, pay the pool, swap). We looked
for a one-transaction buy of graduated tokens in the Prosper router (its implementation's function selectors
looked up by name) and found none, so a pool buy counts as three.

Proof of the live runs: [Proof](#proof).

## Partial failure

- Anything that carries PROS (buys, PROS sends) runs with `allowFailure = false`: if one fails, the whole
  transaction reverts and every PROS stays in the wallet. A reverted call returns its PROS to Multicall3, not
  to the wallet, so letting those fail alone would strand money in the middle.
- USDC payments run with `allowFailure = true`: one failing doesn't stop the others. The check names who
  wouldn't be paid and why; after a send, onego asks USDC which signatures were used, lists the unused ones
  with their expiry, and `onego cancel` voids them in one transaction (`cancelAuthorization`).
- When a PROS step fails, Multicall3 only says "call failed": onego reruns the simulation with every step
  allowed to fail to find which one, and why.
- Nothing is sent unless a fresh check right before signing passes, so a moved price or a spent balance stops
  it first.

Example from the tapes: with 0.000055 USDC for ten payments of 0.00001, the first five are paid and the last
five fail with `ERC20: transfer amount exceeds balance`; the verdict is NOT sendable and says why.

## Quick start

```bash
cd 15-onego && npm install && npm run build
node skill/onego/scripts/onego.mjs recipients --recent 10
node skill/onego/scripts/onego.mjs check plan.json --what-if-pros 20
```

`send` needs a key: the user writes `PRIVATE_KEY=0x...` into the `.env` that `onego setup` points at. onego
never takes a key anywhere else and never prints it.

## How the task's requirements are met

| Requirement | Where |
|---|---|
| Accepts a list of at least 3 independent actions | a plan of any number of `send_pros`, `send_usdc`, `buy` actions; each can be done alone and none needs another's result (`src/plan.ts`) |
| Executes them as a batch | one Multicall3 `aggregate3Value` transaction from the wallet (`src/batch.ts`, `src/send.ts`) |
| Reports the gas saving or step reduction | every check: transactions and gas, batch vs one by one, with the sign as it comes out (`src/baseline.ts`, `src/report.ts`) |
| Handles partial failure clearly | per-action result with the decoded reason; PROS steps all-or-nothing, USDC payments one by one, unused signatures listed and cancellable (`src/check.ts`, `src/send.ts`) |

## Limits

- Only what needs no approve: PROS sends, USDC sends (EIP-3009), Prosper buys with PROS. Selling, swapping an
  ERC-20, or sending p-tokens would need the wallet to approve someone, so onego refuses them and says why.
- A curve market onego doesn't know (only pMusk is in its book) needs its address in the plan.
- One batch must fit one transaction: onego refuses above 30,000,000 gas rather than split it.

## Tests

```bash
npm run build && npm test
```

50 tests, offline. The chain-facing ones replay tapes recorded from mainnet by `node test/record-tapes.mjs`
(after a build): quotes, recent wallets, the airdrop, the buys, and both with too little money.

## Proof

Live transactions: to be added after the runs from the user's wallet.
