---
name: turnstile
description: >
  A pay-per-request API on Pharos Atlantic testnet (eip155:688689) with x402: two paid routes selling live Pharos
  mainnet data (0.001 and 0.005 test USDC), free /health and /catalog, its own facilitator (/verify, /settle,
  /supported), and a buyer that pays step by step and then checks the settlement on Atlantic. Rejects underpaid and
  forged payments with another 402. Keys only from env files. Use when someone wants to run, try or buy from an
  x402 paywall on Pharos.
version: 1.0.0
requires:
  anyBins:
  - node
---

# turnstile

One bundled script, Node 20+: `node scripts/turnstile.mjs <command>`.

## Before anything

Ask where the keys are. Never ask the user to paste a key into the chat, and never print, read out or copy a key.
- seller key: `SELLER_PRIVATE_KEY` in an env file (`--seller-env <file>`). It needs Atlantic PROS for gas.
- buyer key: `BUYER_PRIVATE_KEY` or `PRIVATE_KEY` in an env file (`--buyer-env <file>`). It needs Atlantic test USDC.

`node scripts/turnstile.mjs balances --seller-env … --buyer-env …` shows both addresses and what they hold. If the
seller has no PROS or the buyer has less USDC than a purchase costs, say so and stop. Funding is the user's job.

## Commands

- `demo --seller-env … --buyer-env …`: starts the API on a free local port and walks the whole thing:
  a free route, two paid routes, an underpaid try, a forged signature, the facilitator's /supported.
  Then balances before and after.
- `serve --seller-env … [--port 4028]`: runs the API and the facilitator on 127.0.0.1 until stopped.
- `buy <url> --buyer-env … [--max 0.01] [--mode honest|underpay|forged]`: one purchase with every step printed.

## Retelling a purchase

Go step by step: what the 402 asked for, what was signed, what came back (status, PAYMENT-RESPONSE tx), and what
Atlantic says about that tx (status, AuthorizationUsed for this nonce, USDC Transfer to the seller). Give the
pharosscan link. A refused payment: quote the reason from the second 402 and say no money moved.
