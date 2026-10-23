---
name: trenchsaga
description: >
  Rotates a Prosper (pros-per.xyz) bonding-curve bag on Pharos mainnet from one token to another as a saga:
  approve, sell, unwrap, buy, each step checked on chain before the next, with retries for transient failures
  and a clean rollback when a step can't be done. Use when the user wants to move out of one Prosper token into
  another, buy a first bag of a Prosper token, or check or resume a rotation that was interrupted.
requires:
  anyBins:
  - node
---

# trenchsaga

Run with Node 20+ from this skill's folder: `node scripts/trenchsaga.mjs <command>`.

| Command | What it does |
|---|---|
| `setup` | data folder, whether a key is there (address only), settings |
| `plan <A> <B>` | what a rotation A -> B would do, with quotes. Sends nothing |
| `rotate <A> <B> --yes` | runs the rotation: approve A, sell A, unwrap, buy B |
| `enter <B> <PROS> --yes` | buys a first bag of B |
| `status [id]`, `log [id]` | which step a saga is in, and its journal |
| `resume [id]` | continues an interrupted saga from where it stopped |

A and B are Prosper market addresses. Exit codes: 0 done, 1 error, 2 bad input or no key, 3 rolled back
(or stuck while rolling back: show `status`).

## Rules for the agent

1. Always run `plan` first and show it. Only add `--yes` after the user said yes in the chat for this run.
2. While it runs, the journal lines show each step: sending, sent (tx link), confirmed, verified. Show the
   final status table as is.
3. If the saga rolled back, say which step failed and what was undone, with the tx links.
4. The key lives only in `.env` in the data folder (`setup` prints where). Never ask for it in the chat and
   never write it into a command. If there is no key, tell the user to put `PRIVATE_KEY=0x...` there themselves.
5. Never raise `max_buy_pros` on your own.
