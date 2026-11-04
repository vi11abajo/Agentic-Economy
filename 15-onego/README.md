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
| Send PROS (to plain wallets) | Multicall3 calls the recipient with `value` | the PROS rides along with the call |
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
  it first. That check shows the real USDC signatures to the node, so a refused send lists them for `cancel`
  too.
- The hash and every signature are saved to disk before broadcasting. After mining, the amounts onego reports
  are the chain's: tokens from the transaction's own Transfer events, PROS from the balances. Anything
  Multicall3 gained is shouted about.

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
- PROS goes to plain wallets only: a contract (WPROS, for one) may credit the PROS to whoever called it, which
  inside the batch is Multicall3. onego refuses PROS sends to any address with code.
- A curve market onego doesn't know (only pMusk is in its book) needs its address in the plan.
- One batch must fit one transaction: onego refuses above 30,000,000 gas rather than split it.

## Tests

```bash
npm run build && npm test
```

64 tests, offline. The chain-facing ones replay tapes recorded from mainnet by `node test/record-tapes.mjs`
(after a build): quotes, recent wallets, the airdrop, the buys, both with too little money, and PROS sent to
a contract (refused).

## Proof

Recorded for the walkthrough video on 2026-11-04: an agent installed the skill from this repo and was asked in
plain words for both runs, from a small test wallet (0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb).

- **Airdrop, sent.** The agent ran `recipients --recent 10` (wallets seen in blocks 22093704 to 22093717), wrote
  the plan, checked it ("ready to send", 825,739 gas estimated vs 734,069 one by one) and sent it:
  [0x2eb371bf…bd434](https://www.pharosscan.xyz/tx/0x2eb371bf2e11ae1de11fb4fa534ca9177e2ebc0447f75f067481f724932bd434),
  block 22093758, status success, gas used 631,932. The receipt holds 10 USDC `Transfer` events from the wallet,
  10 raw units (0.00001 USDC) each, one to each recipient.
- **Buys, refused.** pTACO, pCARR and pMusk for 5 PROS each: every buy passed in the simulation (1 transaction
  instead of 7, -19.63% gas), and the verdict was NOT sendable: "not enough PROS: the wallet has 0.039814, the
  batch needs 15 plus about 0.004887 for gas". The agent sent nothing and said why.

An earlier take of the same airdrop
([0x1c2ed683…21d3e](https://www.pharosscan.xyz/tx/0x1c2ed683b9d7231fd38019a2c4dd420e0259e6579d765b07d9554a6abb821d3e))
caught a bug: two recipients got other USDC between the check and the read-back, and onego reported their whole
balance change (238.82 USDC) as this payment. The agent checked the receipt itself and said so. onego now counts
tokens from the transaction's own Transfer events.
