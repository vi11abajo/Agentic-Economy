# bouncer: a policy gate that judges what a transaction would do, not what it claims

Task 16 of the Pharos Agent Arena (policy-gatekeeper). Folder: `16-bouncer`. Status: draft, 2026-11-04.

## Why

The task: a skill that sits in front of an agent's actions and checks every requested action against a policy
(spend limits, allowlisted addresses or contracts, time windows) before letting it through. Requirements:

1. A policy file with at least 3 rule types: spend limit, allowlist, time window.
2. Every request returns allow or deny with the specific rule that decided it.
3. Denied actions are never executed; at least one deny per rule type is shown.
4. An audit log of all decisions.

What the leaders did (details in `../../../../docs/arena-competitors.md`, section 16, read from clones of
2026-11-02): shoupeorg has no signer at all (live balance reads plus an off-chain demo ledger); edycutjong takes
`--to` and `--amount` from the caller and sends only on Atlantic testnet. Both judge the request as the caller
describes it. A transaction can say one thing at the top and do another inside: a call to a "known" market can
reach contracts nobody listed and move tokens nobody mentioned.

bouncer judges the transaction by its call trace instead. Before anything is signed, the exact unsigned
transaction is run through `debug_traceCall` with `callTracer` on Pharos mainnet, and every rule reads the trace:
every contract it calls, every PROS and token amount that would leave the wallet, every approval it would grant.
The user picked this direction on 2026-11-04 (option 1 of three) and approved the rule list below.

## Verified facts this design rests on (Pharos mainnet, 2026-11-04 unless noted)

- `debug_traceCall` with `{"tracer":"callTracer","tracerConfig":{"withLog":true}}` on `https://rpc.pharos.xyz`
  returns frames with `type`, `from`, `to`, `value`, `input`, `output`, `error`, `logs`, nested `calls`.
  Checked with a 1 wei `WPROS.deposit()` from the test wallet: one CALL frame, `value 0x1`, one Deposit log.
- A failed frame carries `error: "execute_revert"` and the revert data in `output` (seen today on a USDC
  transfer over balance, "ERC20: transfer amount exceeds balance"; also recorded in task 09).
- Hidden hops are real: tracing `buyNative(0, deadline, wallet)` with 0.001 PROS on the pMusk market
  `0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f` shows, under the top call, CALLs to
  `0x30bebe432ff53c9b6ed28dd9daf125902cbabb56`, `0x3c22060c99ee18097029151113478b4264041bdb`, WPROS
  `0x52c48d4213107b20bc583832b0d951fb9ca8f0b0` (with the 0.001 PROS) and the pMusk token
  `0xE318ac4113324841265d270Dc2393f1Bf742A7f8` (Transfer log).
- Pharos quirk: a DELEGATECALL frame shows `to` = the proxy itself and `from` = the proxy's caller, and repeats
  the parent's `value` (USDC proxy and the pMusk market both). So DELEGATECALL frames are skipped when counting
  PROS (or it would be counted twice) and add no new address to the allowlist check.
- `debug_traceCall` ignores state overrides on Pharos (task 15). bouncer traces from the real wallet at the
  latest block, so it needs none.
- Test wallet `0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb` holds 0.03923 PROS and 0 USDC right now
  (`eth_getBalance`, `balanceOf`). The live ALLOW run is sized to fit that.

## The policy file

`policy.json` in the bouncer home folder (`BOUNCER_HOME`, outside the repo, next to `.env`). JSON, every amount
as a decimal string in whole units, addresses checksummed or lower case. Example:

```json
{
  "name": "demo wallet rules",
  "wallet": "0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb",
  "time_window": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "08:00", "to": "20:00", "tz": "UTC" },
  "contracts": ["0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f", "..."],
  "recipients": ["0x..."],
  "approvals": { "spenders": [], "unlimited": false },
  "spend": {
    "PROS": { "per_tx": "0.005", "per_day": "0.01" },
    "USDC": { "token": "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", "decimals": 6, "per_tx": "1", "per_day": "2" }
  }
}
```

A broken policy (unknown key, bad address, bad time, missing wallet) refuses to load and every request is
denied with rule `policy` until it is fixed. A policy can't be read halfway.

## Rules, in the order they are checked

The first rule that fails decides DENY and names itself plus the concrete reason. An ALLOW lists every rule with
its result. Order is cheap-first: the clock needs no network, the trace is fetched once and all trace rules read
the same trace.

| # | Rule id | What it reads | Fails when | Demo deny |
|---|---|---|---|---|
| 1 | `time_window` | the clock (UTC by default), `days`, `from`/`to` (end exclusive, may wrap midnight) | now is outside the window | a policy whose window does not include the recording time |
| 2 | `simulation` | the trace | the top frame has `error`: the tx would revert anyway, so it is never let through | a buy with more PROS than the wallet has |
| 3 | `contracts` | every CALL / CALLCODE / CREATE frame's `to`, at every depth; STATICCALL is a read and is skipped; DELEGATECALL adds nothing on Pharos (see facts) | any called contract (an address with code) is not on the list | pMusk buy with only the market listed: denied at depth 1 on `0x30be…bb56` |
| 4 | `recipients` | addresses that receive PROS (CALL with value to an address without code) and the `to` of every ERC-20 Transfer log whose `from` is the wallet | a receiver is not on the list and is not the wallet itself | a PROS send to an address not on the list |
| 5 | `approvals` | Approval logs whose owner is the wallet | spender not in `approvals.spenders`, or amount = max uint256 while `unlimited` is false | `approve(router, max)` |
| 6 | `spend.per_tx` | PROS out = sum of `value` on non-DELEGATECALL frames whose `from` is the wallet + gas limit x max fee; tokens out = sum of Transfer logs from the wallet, per token | over the per-tx cap of that asset; an asset that leaves the wallet but has no entry in `spend` is denied (cap 0) | a buy of 0.01 PROS against `per_tx` 0.005 |
| 7 | `spend.per_day` | this request's amounts + what the audit log says was actually sent in the last 24 h (from receipts, per asset) | the sum is over `per_day` | after allowed sends, the next one that would cross the daily cap |

Details settled while writing this up (Claude's calls, the user can change them):

- The signing key's address must equal `policy.wallet`, or `send` refuses before tracing.
- An address on `contracts` is also an allowed token/PROS receiver (paying a listed market is fine).
- Gas is not counted in the spend caps: they limit what leaves the wallet to others. The `simulation` rule
  still denies when value + worst-case gas is more than the balance, and every report shows the gas cost.
- Rule 7 counts a broadcast tx with no receipt yet at its traced amounts, until a receipt says it reverted.
- `approvals` covers ERC-20 Approval (3 topics), ERC-721 Approval (4 topics) and ApprovalForAll: the spender
  or operator must be listed. Permit2 and off-chain permits are out of scope for v1 and the README says so.
- Frames that reverted inside a tx that succeeds: their called contracts are still checked by `contracts`
  (stricter), their amounts are not counted. A CREATE/CREATE2 frame is denied by `contracts` (a new address
  can't be on a list). Precompiles (0x01 to 0x11) are skipped. "Has code" = `eth_getCode` at the traced block.
- `send` traces again at send time and that decision is the one that counts; nonce and fees are read then.
- `tz` is UTC only in v1.
- The audit log is appended under a lock file, and every decision is logged, including denies by `policy`.

Every deny names the frame where it was found when there is one: depth, the address, and the call path from the
top (for example `wallet -> 0x5c3e…8b7f -> 0x30be…bb56`).

## Requests

The agent never hands bouncer a signed transaction. It hands an unsigned one, in one of these forms (same idea as
task 09's preflight):

- `bouncer check pros <to> <amount>`
- `bouncer check token <USDC|0x…> <to> <amount>`
- `bouncer check approve <token> <spender> <amount|max>`
- `bouncer check call <contract> "<signature>" [args…] [--value <PROS>]`
- `bouncer check raw <to> <data> [--value <PROS>]`
- `bouncer check --tx <file.json>` with `{"to", "data", "value"}`: how another tool's output is gated

`bouncer send <same request>` runs the whole check again at that moment and, only on ALLOW, signs exactly the
traced transaction (same to, data, value, gas limit from the estimate) with the key from `BOUNCER_HOME/.env`,
broadcasts, waits for the receipt and records the real amounts sent. On DENY, `send` exits non-zero and nothing is
signed: there is no code path from a DENY to the signer, and tests prove it.

Output: a short human report, or `--json` with `{decision, rule, reason, frame?, checks[], request, policy_hash}`.
Exit codes: 0 allow (or sent), 3 deny, 2 bad input, 1 error (network). A network error is never an ALLOW.

## Audit log

`BOUNCER_HOME/audit.jsonl`, append-only, one line per decision: time, request, unsigned tx, policy file hash,
every check with its result, decision, deciding rule and reason; on send also the tx hash (written before
broadcast) and then the receipt outcome with the real amounts. `bouncer log [--today] [--deny]` prints it. Each
line carries the hash of the previous line, so an edited or deleted line is detected by `bouncer log --verify`.
The daily spend (rule 7) is read only from receipt lines of this log.

## The skill

`16-bouncer/skill/bouncer/SKILL.md`: the agent asks bouncer before every on-chain action, shows the decision
with the rule, never retries around a deny (no splitting an amount, no other recipient, no editing the policy or
the log on its own), and changes the policy only when the user asks in plain words, showing the diff first.
`bouncer policy explain` prints the rules in plain English; `bouncer policy add-contract <addr>` etc. edit it.

## Demo (video +50, the user launches the recording; Claude never signs)

Real agent session on mainnet with the test wallet, plain-English prompts from a newbie:

1. Install and set a policy in words ("only the pMusk market, at most 0.005 PROS per buy, 0.01 a day, weekdays").
2. "Buy pMusk for 0.001 PROS": DENY `contracts` (the market calls `0x30be…bb56` which isn't listed). The agent
   explains, the user adds the contracts the trace showed.
3. Same buy: ALLOW, sent live, tx hash, receipt amounts in the log.
4. "Buy for 0.01": DENY `spend.per_tx`. A few more small buys until DENY `spend.per_day`.
5. "Send 0.001 PROS to <random address>": DENY `recipients`. "Approve USDC to the router, unlimited": DENY
   `approvals`. A buy larger than the balance: DENY `simulation`.
6. Policy window narrowed to exclude now: DENY `time_window`.
7. `bouncer log --verify`: every decision of the session, chain intact.

The exact amounts are set at build time against the wallet balance (0.03923 PROS on 2026-11-04).

## Non-goals

- Not a wallet guard for transactions signed outside bouncer; it gates what goes through it.
- No EIP-7702, no approvals to anyone, no contract of our own.
- No price oracle: limits are per asset in its own units, not in dollars.
- No Atlantic: mainnet only, as in the other tasks.

## Left to the builder

- Code layout, names (with some character, see the repo's other tasks), test fakes for the chain.
- Reuse is by copying: 09-preflight's trace `effects()` and 15-onego's RPC chain are good starting points, but
  each task folder stays self-contained.
- The demo's exact amounts and the contracts list after a real trace on the build day.
