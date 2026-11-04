---
name: bouncer
description: >
  bouncer: a policy gate in front of every on-chain action on Pharos mainnet. Before anything is signed it traces
  the exact transaction on mainnet (debug_traceCall) and judges what it would REALLY do against the user's
  policy: allowed time window, every contract it would touch at any depth, who receives PROS or tokens,
  approvals, and spend caps per transaction and per 24 hours. Answers ALLOW or DENY with the rule that decided;
  only ALLOW can be sent; every decision goes to a hash-chained audit log. Use whenever an agent is about to send
  PROS or tokens, call a contract, buy, approve, or when the user wants spending limits, an allowlist, a time
  window or an audit trail for their agent's wallet.
requires:
  anyBins:
  - node
---

# bouncer

Run with Node 20+ from this skill's folder: `node scripts/bouncer.mjs <command>` (use the absolute path of
`scripts/bouncer.mjs` from elsewhere). One bundled file, no install. Data folder: `BOUNCER_HOME` if set, else
`%APPDATA%\bouncer` or `~/.config/bouncer`; `bouncer setup` prints it.

| Command | What it does |
|---|---|
| `bouncer check <request>` | traces the request on mainnet and judges it; nothing is signed, no key needed |
| `bouncer send <request>` | judges it again at that moment; only on ALLOW signs with the key in `.env`, sends, waits for the receipt |
| `bouncer policy` | the rules in plain words |
| `bouncer policy init --wallet <0x...>` | starts a policy from the example (weekdays 08:00-20:00 UTC, 0.005 PROS per tx, 0.01 per day, no contracts) |
| `bouncer policy add-contract / add-recipient / add-spender <0x...>` (and `remove-...`) | edits a list |
| `bouncer policy set window mon,tue,wed 09:00-18:00` / `window off` | the time window (UTC) |
| `bouncer policy set spend.PROS.per_tx 0.01` / `spend.PROS.per_day 0.05` | caps; a token also needs `spend.<NAME>.token` and `.decimals` |
| `bouncer policy set approvals.unlimited true|false` | whether unlimited approvals may ever pass |
| `bouncer log [--today] [--deny]` | the decisions so far |
| `bouncer log --verify` | checks that no line of the log was edited, removed or reordered |
| `bouncer setup` | data folder, policy status, whether a key is there (address only) |

Requests: `pros <to> <amount>`, `token <USDC|0x...> <to> <amount>`, `approve <token> <spender> <amount|max>`,
`call <contract> "<fn(types)>" [args...] [--value <PROS>]`, `raw <to> <0x data> [--value <PROS>]`,
`--tx <file.json>` with `{"to","data","value"}` (value in wei) for a transaction another tool built.
Add `--json` for machine-readable output. Exit codes: 0 allow or sent, 1 network error, 2 bad input or no key,
3 deny.

## The rules, in the order they are checked

The first rule that fails decides. Say its id and its reason to the user as bouncer printed them.

1. `time_window`: only inside the allowed days and hours (UTC, end exclusive; a window like 22:00-02:00 belongs
   to the day it opens).
2. `simulation`: the transaction would fail anyway, or the wallet can't cover the value plus gas.
3. `contracts`: every contract the transaction calls, at ANY depth of the trace, must be on the list. This is
   the point of bouncer: a call to a listed market that quietly calls something else is caught here, with the
   path (`wallet -> 0x5c3e…8b7f -> 0x30be…bb56`).
4. `recipients`: PROS or tokens may only go to the wallet itself, listed recipients, or listed contracts.
5. `approvals`: only to listed spenders, and never unlimited unless the policy says so.
6. `spend.per_tx`: per asset, as counted from the trace. An asset with no cap may not leave at all.
7. `spend.per_day`: what the log says left in the last 24 hours plus this one.

`policy` is the eighth answer: a broken policy file, or a key in `.env` that belongs to a different wallet,
denies everything until it's fixed.

## How to work with it

1. Before ANY on-chain action for this wallet, run `bouncer check` with the exact request. Never call the chain
   some other way to get around it.
2. Tell the user the answer in their language: ALLOW, or DENY plus the rule and its reason. On a `contracts`
   deny, name the contract and how the transaction reaches it, and say that the trace found it, not the request.
3. A deny is the right answer, not an error. Don't retry with a split amount, another recipient, a different
   route or a later timestamp to slip past it, and never edit `policy.json` or `audit.jsonl` on your own.
4. Change the policy only when the user asks for that change in plain words. Use the `policy` commands (they
   refuse a change that would break the file), show what changed, then check again.
5. Run `send` only after an ALLOW and only when the user tells you to send, in that turn. Report the
   pharosscan link and what `send` says left the wallet.
6. If `send` reports status unknown, don't send again: look the printed hash up on pharosscan first.
7. `bouncer log --verify` answers "has anyone tampered with the log?". A broken log also makes `spend.per_day`
   deny, because bouncer can't know what was already spent.

## Key and wallet

- The key lives only in `.env` in the data folder. The user writes `PRIVATE_KEY=0x...` there themselves. Never
  ask for it in the chat, never put it in a command, never read or print the file. If the user pastes a key
  anyway, don't use it: tell them it's exposed now and they should move the funds to a fresh wallet.
- `check` needs no key at all, so policies can be tried before any wallet is set up.

## Limits (say them if they matter)

- It gates what goes through bouncer. A transaction signed somewhere else never meets it.
- `recipients` checks who gets money straight from the wallet. A listed contract that takes a recipient argument
  (a router's swap `to`, a withdraw `receiver`) can still pay the output to someone else, so list only contracts
  you trust with that; the spend caps still limit what goes in.
- Caps are per asset in its own units (no dollar prices). Gas isn't counted in the caps, it's shown separately.
- Permit2 and off-chain permit signatures aren't checked yet; ERC-20, ERC-721 and ApprovalForAll approvals are.
- Time windows are UTC only.
- Mainnet only (chain 1672).
