---
name: trenchsaga
description: >
  Rotates a Prosper (pros-per.xyz) bonding-curve bag on Pharos mainnet from one token to another as a saga:
  approve, sell, unwrap, buy, each step checked on chain before the next, with retries for transient failures
  and a clean rollback when a step can't be done. Use when the user wants to move out of one Prosper token into
  another, buy a first bag of a Prosper token, or check, explain or resume a rotation.
requires:
  anyBins:
  - node
---

# trenchsaga

Run with Node 20+ from this skill's folder: `node scripts/trenchsaga.mjs <command>` (use the absolute path of
`scripts/trenchsaga.mjs` when running from elsewhere). It's one bundled file, no install needed.

| Command | What it does |
|---|---|
| `setup` | data folder, whether a key is there (its address only), settings |
| `config set k=v ...` | `max_buy_pros`, `slippage_pct`, `max_attempts`, `receipt_timeout_sec` |
| `plan <A> <B> [--amount N]` | what a rotation A -> B would do, with quotes. Sends nothing |
| `rotate <A> <B> --yes` | runs it: approve A, sell A for WPROS, unwrap, buy B |
| `enter <B> <PROS> --yes` | buys a first bag of B (one step) |
| `status [id]`, `log [id]` | which step a saga is in (latest by default), and its journal |
| `resume [id]` | continues an interrupted or stuck saga from where it stopped |

A and B are Prosper market addresses (pToken addresses work too). Demo switches, only when the user asks for a
demo: `--fail-at <step>` makes that step fail for real (impossible minOut), `--drop-at <step>` sends its first
attempt underpriced. Exit codes: 0 done, 1 error, 2 bad input or no key, 3 rolled back (or stuck).

## How to run a rotation with the user

1. Run `plan` and show it in a code block. Say what it will sell, about what it gets, and that a failure
   rolls back to A.
2. Ask. Only after a clear yes in the chat for this rotation, run `rotate ... --yes`. Never add `--yes` on your
   own, and never raise `max_buy_pros` on your own.
3. While it runs, every line of the journal is printed: sending (nonce, fee), sent, confirmed, verified. Show
   the final status table as is, with the tx links.
4. Explain what happened in plain words:
   - "refused" or "not mined in time" followed by a new send: a transient failure, retried (a replacement
     keeps the nonce, so it can't happen twice);
   - "reverted" with "simulation passes on fresh state": the price moved between sending and mining, retried;
   - "simulation fails on fresh state": permanent. The steps already done were undone in reverse order: name
     them and link the undo transactions. Buying A back returns a bit less A (the curve's 1% fee each way);
   - `stuck`: an undo couldn't be done. Show `status`, say which undo stopped and why, and offer `resume`.

## Key and wallet

- The key lives only in `.env` in the data folder (`setup` prints where). The user puts `PRIVATE_KEY=0x...`
  there themselves. Never ask for it in the chat and never write it into a command. If the user pastes one
  anyway, don't use it: tell them it's now exposed and they should move funds to a fresh wallet.
- Suggest a small test wallet. `max_buy_pros` caps every buy (0.01 PROS by default).
