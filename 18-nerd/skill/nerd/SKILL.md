---
name: nerd
description: >
  nerd: explains a Pharos contract function strictly from the official Pharos developer docs (Docs MCP, with the
  exact lines and links), then calls that same function on Pharos mainnet through the Pharos Chain MCP, then reads
  the answer against what the docs promised: MATCH, DIFFERENT, DOCS SILENT or CHAIN SAYS NO. Read-only: it only
  uses eth_call and estimate_gas, it never signs or sends. Use whenever the user asks what a Pharos contract
  function does, what its parameters mean, whether the docs are right about it, what an x402 payment or a CCTP
  message really looks like on chain, or to explain a function from a recent mainnet transaction.
version: 1.0.0
requires:
  anyBins:
  - node
---

# nerd

Run with Node 20+ from this skill's folder: `node scripts/nerd.mjs <command>` (use the absolute path of
`scripts/nerd.mjs` from elsewhere). One bundled file, no install, no keys. Data folder: `NERD_HOME` if set, else
`%APPDATA%\nerd` or `~/.config/nerd`.

## The order is the point

Always three steps, always in this order, each one shown to the user:

1. `nerd docs <target>`: Docs MCP only. Searches the Pharos docs, opens the pages, prints the lines that talk
   about the target word for word, numbered by source. `call` refuses to run until this was done (an hour at most).
2. `nerd call <target>`: Chain MCP only. eth_call on the contract the docs pointed at, pinned to one block.
3. `nerd read <target>`: holds one up against the other.

Then explain it to the user in your own words, built only from what step 1 printed: what the function is for,
what each parameter means, and what the result means for them. Quote and link the docs line behind every claim
(`[n]` maps to the sources list). Anything step 1 did not print, the docs did not say: say "the docs don't say",
never fill it in from general knowledge, even when you know the answer.

## Targets

- `x402-domain`: USDC `DOMAIN_SEPARATOR()`. The x402 docs give the EIP-712 name, version, network and token a
  payment is signed with; nerd rebuilds the separator from exactly those values and compares.
- `x402-decimals`: USDC `decimals()` against the docs' "6 decimals" and their worked example, and turns the
  docs' example prices into the base units a payment carries.
- `cctp-send --dest <domain> --from <address> [--recipient <address>] [--body <text>] [--min-finality <n>]
  [--caller <address>]`: `MessageTransmitterV2.sendMessage`, simulated from `--from` (the recipient defaults to
  it, the threshold to the docs' finalized value). Also cuts the newest real `MessageSent` on chain with the
  docs' header table. Nothing is sent, ever.
- `--to <contract> --sig "name(type,...)" [--returns "type,..."] [--args a,b]`: any function on any contract.
- `--tx <hash>`: the function a real transaction called, replayed as its sender one block earlier.
- `nerd first [--max-blocks 300]`: walks back from the newest block to the first transaction that calls a
  function, and prints the `--tx` to use next.

Pull targets and flags from the user's words: "my wallet" is the address they gave; "domain 0" is `--dest 0`.
If they ask for something nerd has no preset for, use `--to/--sig` with the address and signature they gave.

## Reading the verdicts

- MATCH: the docs and the chain agree. Say what that means in practice (the reading's "in plain words" lines).
- DIFFERENT: the docs and the chain disagree. Say which is which, quote the docs line, show the chain value. Do
  not decide that the docs "probably meant" something.
- DOCS SILENT: the docs say nothing here. Say so plainly; it is a real answer, not a failure.
- CHAIN SAYS NO: the contract refused (its own reason is shown). For a simulated write it means a real send would
  revert and only burn gas.

Exit codes: 0 done; 1 network or server trouble (try again); 2 bad input, or the docs step was skipped.

## Never

Never sign or send a transaction, never ask for a private key: nerd has no signing code at all. If the user wants
to really send what was simulated, tell them what the call would be and that sending it is their move, from
their own wallet.
