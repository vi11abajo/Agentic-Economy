---
name: preflight
description: >
  preflight: dry-runs a Pharos mainnet transaction before it is sent. Simulates it on the current state through
  the Pharos Chain MCP (eth_call + estimate_gas), says whether it succeeds or reverts and why, what gas it costs,
  and what it changes (PROS and token balances, allowances, before -> after), then gives a GO or NO-GO. Sending
  goes through it too: it simulates again right before signing and refuses to send anything that fails. Use
  whenever the user wants to send PROS or tokens, approve, or call a contract on Pharos, or asks what a
  transaction would do or cost.
requires:
  anyBins:
  - node
---

# preflight

Run with Node 20+ from this skill's folder: `node scripts/preflight.mjs <command>` (use the absolute path of
`scripts/preflight.mjs` when running from elsewhere). One bundled file, no install.

| Command | What it does |
|---|---|
| `check <tx> [--from <address>]` | simulate only: GO or NO-GO, the revert reason, gas cost, before -> after |
| `send <tx>` | the same from the signer's wallet, and says what `--yes` would send |
| `send <tx> --yes` | simulates again, signs and sends only if GO, then compares the result with the simulation |
| `log`, `wallet`, `config [set k=v]` | past checks and sends, the signer's address, settings |

`<tx>` is one of:

- `pros <to> <amount>`: send PROS
- `token <token> <to> <amount>`: send an ERC-20; `token` is an address or `USDC` / `WPROS`; amount in tokens
- `approve <token> <spender> <amount|max>`: set an allowance
- `call <to> "<fn(type,...)>" [args...] [--value PROS]`: any contract call by its signature
- `raw <to> <0xdata> [--value PROS]`: a transaction someone else prepared

## How to use it

1. Whatever the user wants to send, turn it into one of the forms above and run `check` (or `send` without
   `--yes`). Paste the output as is in a code block.
2. Explain the verdict in plain words: will it succeed, what does it cost in PROS (and dollars), what changes
   for whom. Point out every WARNING line (an unlimited approval, a call to an address with no code).
3. **NO-GO (exit 3):** say why, using the revert reason or the failed check. Don't look for a way around it:
   don't change the amount, the limits or the target on your own, and don't send it some other way. If the
   user wants to change something, run `check` again with the change.
4. **GO:** ask the user plainly whether to send it. Only after a clear yes, run `send ... --yes`. It simulates
   once more; if the chain changed and it is now NO-GO, it blocks and sends nothing. Never add `--yes` on your
   own.
5. After a send, paste the result: the explorer link and each line marked AS SIMULATED or DIFFERENT.

## The key

`preflight --help` says whether a key is there (the signer's address only). `send --yes` signs with
`PRIVATE_KEY` (or `MNEMONIC`) from `.env` in the data folder (`--help` prints it). The user puts it there
themselves. Never ask for a key, never read or print the .env, never pass a key on a command line. Without a
key, `check --from <address>` simulates as any address.

Settings: `gas_buffer_pct` 20 (gas limit = estimate + 20%), `max_fee_multiplier` 1.5, `max_pros_per_tx` 1 (a
transaction sending more PROS is NO-GO). Change them only when the user asks.
