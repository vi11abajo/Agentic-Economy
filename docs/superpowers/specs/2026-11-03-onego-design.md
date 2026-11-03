# onego: several actions in one Pharos transaction, nobody gets rights to the wallet

Task 15 of the Pharos Agent Arena (batch-executor). Folder: `15-onego`. Status: design approved by the user on 2026-11-03.

## Why

The user wants a reusable skill anyone can install and ask in plain words, for example "pay my employees 10000
USDC each to these addresses" or "buy pTACO, pCARR and pMusk for 5 PROS each", and get all of it done in ONE
transaction on Pharos mainnet.

Two demo and test runs (chosen by the user), each its own single transaction:

1. Airdrop: "airdrop 0.00001 USDC each to the 10 most recent real wallets from the latest blocks" (10
   independent actions).
2. Prosper buys: "buy pTACO, pCARR and pMusk for 5 PROS each" (3 independent actions).

Requirement 1 ("a list of at least 3 independent actions") is read as: each action can be done on its own and
none needs another's result. The wrap, pay-pool and swap steps of one V2 buy depend on each other, so together
they are one action. The user may say it in any language.

The hard rule from the user: the skill gives NOBODY rights over the wallet or its funds. No EIP-7702 delegation
(to anyone's contract, public or not), no `approve` to Multicall3 or any other middleman. It works from a plain
EOA. Competitors either batch plain sends (shoupeorg, where the batch costs more gas than separate sends) or
approve tokens to Multicall3 (edycutjong, whose own README quotes Multicall3's "never approve" warning). onego
batches without either.

## Arena requirements and how onego meets them

1. At least 3 independent actions: a plan holds any number of actions of the supported kinds below.
2. Executed as a batch: one Multicall3 `aggregate3Value` transaction from the user's EOA.
3. Gas or step saving: the report compares the batch with the same actions sent one by one (see "Comparison").
4. Partial failure: per-action result, with the failure policy below.

## How it works (verified by mainnet dry runs on 2026-11-03)

Multicall3 on Pharos mainnet: `0xcA11bde05977b3631167028862bE2a173976CA11` (listed in Pharos docs, canonical
contracts). Chain id 1672, RPC `https://rpc.pharos.xyz`.

Supported actions in v1:

| Action | How it runs inside the batch | Why nobody gets rights |
|---|---|---|
| Send PROS | Multicall3 call to the recipient with `value` | the PROS is sent with the call, nothing is left behind |
| Send USDC | `USDC.transferWithAuthorization(...)` (EIP-3009). The user signs one TransferWithAuthorization per payee off-chain; the batch submits them | each signature can only move that exact amount to that exact address before its deadline |
| Buy a graduated Prosper token (V2 pool) with PROS | `WPROS.deposit{value}` then `WPROS.transfer(pair, in)` then `pair.swap(out, to = user)` | Multicall3 only spends the WPROS it minted in the same call; the tokens go straight to the user |
| Buy a Prosper curve token with PROS | `market.buyNative(minOut, deadline, recipient = user)` with `value` (selector `0x383f5607`) | the market pays the user directly |
| Pick recipients from recent blocks | read only: walk back from the latest block, take distinct transaction senders, keep only addresses with empty code (plain wallets; anything with code, including EIP-7702 delegated ones, is skipped), skip the user's own address, newest first | read only |
| Read-backs | `balanceOf` of the user and of Multicall3 for every token touched | read only |

Facts the builder needs:

- USDC `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`: EIP-712 domain name `USDC`, version `2`, chainId 1672.
  Balance mapping slot 9 (`keccak(addr, 9)`), for state overrides in simulation.
- WPROS `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0`. Prosper V2 factory
  `0x9343d6f1a7058a9ffd43028666db23cfce3e0d1e` (10 pairs, all p-token/WPROS). Pair fee 0.5%:
  `out = in*9950*rOut / (rIn*10000 + in*9950)`; asking 0.1% more reverts.
- Do NOT use the Prosper router (`0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5`) `buyInnerNative`: it pays
  `msg.sender`, which inside a batch is Multicall3, where anyone could take the tokens.
- Curve markets expose `quoteBuy(uint256) -> (usedGross, fee, netIn, pTokenOut)`, `phase()`, `endsAt()`,
  `pToken()`. pMusk market `0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f` is in phase 3 (failed, inner only, ended
  2026-10-30) and still sells. onego warns about such markets before buying.
- `eth_call` and `eth_estimateGas` on Pharos honor `stateOverride`; `debug_traceCall` ignores it. Public RPC
  rate limit `-32011`: back off about 1.5 s. `eth_gasPrice` is 10 gwei.
- USDC has 6 decimals: 0.00001 USDC = 10 units. USDC also has `authorizationState(address,bytes32)` and
  `cancelAuthorization(...)` (both answer on mainnet; cancel reverts with "ECRecover: invalid signature" on a
  dummy signature, so it exists).
- Curve buys don't leave change behind: a dry run of `buyNative` through Multicall3 with 5 and 5000 PROS left
  Multicall3 with 0 PROS (`getEthBalance`), `quoteBuy.usedGross` equal to the amount sent. Sending more than the
  curve can take (500000 PROS, usedGross 19985) reverted instead of refunding. Still: send exactly `usedGross`
  and check Multicall3's PROS balance in the simulation.
- Block gas limit on mainnet: 1,000,000,000 (latest block, 2026-11-03).
- Airdrop dry run (2026-11-03): 78 recent blocks gave 10 plain-wallet senders; one `aggregate3` with 10
  `transferWithAuthorization` of 10 units each: all 10 ok, each recipient +0.00001 USDC; `estimateGas` 900,456.
  A single plain `USDC.transfer` of the same amount from the payer estimates 79,757, so 10 one by one = 797,570:
  the batch costs about 13% MORE gas (signature check and a fresh nonce slot per payment) but replaces 10
  transactions with 1. The report must say exactly that.
- Run 1 dry run (airdrop, see above): 1 transaction, 900,456 gas vs 10 transactions, 797,570 gas. The batch
  costs about 13% more gas; the saving is 10 transactions to 1.
- Run 2 dry run (2026-11-03, script buys.mjs): one `aggregate3Value`, 7 action calls plus 9 read-backs, 15 PROS:
  pTACO 579.30, pCARR 1192.77, pMusk 663,101 to the wallet; Multicall3 ends with 0 pTACO, pCARR, pMusk, WPROS
  and 0 PROS. `estimateGas` 564,179. One transaction at a time: V2 buy = wrap 57,576 + pay pool 44,786 + swap
  124,318, pMusk buy 176,567: 7 transactions, 629,927 gas. Batch: 1 transaction, 10.44% less gas. WPROS balance
  mapping is slot 3 (for overrides in the one-by-one estimates).
- Reference dry run: one `aggregate3Value`, 18 calls, 15 PROS: pTACO 579.30, pCARR 1176.62 and pMusk 663,101 for
  5 PROS each plus 3 x 10000 USDC salaries; all calls ok, Multicall3 ends with 0 of every token and 0 WPROS;
  `estimateGas` 791,137. A separate run with one salary exceeding the balance showed that salary fail and the
  other two go through.

## Failure policy (agreed with the user)

- Anything that carries PROS (sends, buys) runs with `allowFailure = false`. If one fails, the whole transaction
  reverts and all PROS stays with the user. Reason: a reverted call returns its value to the caller, which is
  Multicall3, not the user.
- USDC salaries run with `allowFailure = true`: a failed one doesn't stop the others; the report names who was
  not paid and why. Signatures get a short validity window (default 15 minutes) so an unused one can't be
  submitted much later.
- If a plan mixes both and a PROS step fails, the salaries are rolled back too (one transaction). Better
  "nothing went, here is why" than a half-done batch.
- Main protection is before sending: the whole plan is simulated on mainnet first. If any action fails in
  simulation, or Multicall3 would end up holding anything, onego refuses to send until the plan is fixed.
  On chain things can only fail if state changed between the check and the send (price moved, balance spent).

## Shape of the skill

Same pattern as earlier tasks (06 trenchsaga, 14 whatswrong): a bundled Node CLI plus `skill/onego/SKILL.md`.

- The agent (Claude reading SKILL.md) turns the user's words into a plan file (JSON list of actions with
  addresses and amounts) and asks for anything missing. No hardcoded phrases in the CLI.
- `onego recipients --recent <n>`: prints the n most recent plain-wallet senders (rule above) with the block
  each was seen in, so the agent can put them into a plan.
- `onego check <plan>`: needs no key. Resolves tokens (symbol or address, V2 pair or curve market), quotes, and
  simulates the whole batch. USDC authorizations are signed in simulation by a throwaway key whose USDC and
  PROS balances are overridden to equal the payer's real balances, so the outcome matches the real wallet
  without creating live signatures (real signatures exist only inside `send`). Any address can be checked;
  "what if" balances are an explicit flag. Refuses a plan whose simulated batch leaves anything (tokens, WPROS,
  PROS) in Multicall3 or whose gas is over a cap (below the 1,000,000,000 block limit; batches are never split,
  that would break "one transaction"). Prints a table: per action what goes where, expected amounts,
  ok/fail with decoded reason, warnings (failed curve, price impact), batch gas and fee vs one-by-one.
- `onego send <plan>`: re-simulates on fresh state, signs the USDC authorizations and the one transaction with
  the user's key, sends, waits for the receipt, then checks on chain that each recipient got what was planned
  and that Multicall3 holds 0. Prints the tx link and per-action outcome. If any USDC authorization was not
  used (failed salary, or the whole transaction reverted), it lists them with their expiry time and
  `onego cancel` can void them on chain with `cancelAuthorization` (one extra transaction, user's choice).
- `--json` on both for machine use.
- Key: only in `.env` in the data folder (`PRIVATE_KEY=...`), put there by the user. Never asked for in chat,
  never written into a command. Claude never runs `send` with real funds unless the user tells it to in that
  turn; Claude never signs anything itself.

## Comparison (requirement 3)

Report both numbers honestly, whichever way they go:

- Steps: number of separate transactions the user would send without onego vs 1, plus signatures. Baseline per
  action = the cheapest single-wallet way that is verified on chain: each PROS or USDC send 1 (plain `transfer`),
  a curve buy 1 (`buyNative` or the router), a V2 buy 3 (deposit, transfer, swap) unless the builder verifies a
  one-transaction router path for graduated tokens, in which case 1.
- Gas and fee in PROS: `estimateGas` of each standalone transaction from the user's EOA (with overrides where
  needed) summed, vs the batch. Plain PROS sends alone are known to cost more through Multicall3 (shoupeorg's
  numbers); the saving comes from the 21,000 base cost per transaction dropped and the multi-step buys.

## Goals, non-goals, anti-goals

Goals: plain-language requests; one transaction; no rights to anyone; clear per-action report before and after;
mainnet; reusable by anyone with Node 20+.

Non-goals for v1: anything that needs an ERC-20 pulled from the user without EIP-3009 (sending p-tokens, selling
p-tokens, swapping USDC to a token). onego says plainly that it can't do these without an approve and why.
Other DEXes (Faroswap etc.).

Anti-goals: any `approve`, `permit` to a middleman or EIP-7702 delegation; tokens or PROS left in Multicall3;
sending without a fresh simulation; Claude signing or handling the key.

## Builder's calls (left open)

- Live demo: the user funds a wallet of their own (a little USDC for 10 x 0.00001, 15 PROS for the buys, plus
  PROS for gas: about 0.009 PROS at 900k gas and 10 gwei) and puts its key into `.env` themselves; the user runs `send` or tells
  Claude to in that turn. Tests use recorded RPC tapes of the dry runs plus a failing-row case (one recipient
  given more than the balance) to show partial failure.
- Code layout, module names, test fixtures (recorded RPC tapes like 14 whatswrong).
- Exact plan JSON schema and table layout.
- Slippage: V2 swaps use an exact `out`; any surplus input stays in the pool and can be skimmed by anyone, so
  default slippage should be small and shown as a worst case in the table.
- How the post-send check reads per-action outcomes (Transfer / AuthorizationUsed logs and balances, or
  `debug_traceTransaction` callTracer).
