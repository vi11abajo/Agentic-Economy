---
name: remit
description: >
  Reads an invoice or payment request (JSON, plain text or Markdown, PDF with a text layer, PNG with an EIP-681
  payment QR code, or pasted text) and prepares the matching payment on Pharos mainnet (chain 1672) in PROS, WPROS
  or USDC. Flags missing fields, totals that don't add up, ambiguous currencies, broken checksums, public test-key
  payees and wrong-chain links instead of guessing. Checks on chain that the token is real, that the invoice wasn't
  already paid, and (with the payer's address) that the exact transaction would go through. The unsigned
  transaction carries "INV:<reference>" in its input. The user signs in their own browser wallet. Use when someone
  wants to pay an invoice, a bill or a payment link on Pharos.
version: 2.0.0
requires:
  anyBins:
  - node
---

# remit

One bundled script, Node 20+: `node scripts/remit.mjs <command>`. No key, no `.env`.

## How to use it

1. Ask for the invoice (a file path, or the text pasted in chat) and the wallet they will pay from.
2. `node scripts/remit.mjs plan <invoice> --from <their wallet> --out plan.json`
   - exit 0: show the summary as it is. Say who gets how much of which token, the reference that goes into the tx,
     and the dry-run line (gas, fee). Mention any WARN line.
   - exit 2: nothing to pay. Retell each STOP line in plain words and say who can fix it (usually the invoice
     issuer). Never offer a "corrected" payee, amount or token yourself, and never retry with a value you made up.
     If the only stop is EXPIRED_INVOICE and the user confirms it's still owed, rerun with `--allow-expired`.
   - ALREADY_PAID: give the tx link and say the invoice is settled.
3. When they want to pay: `node scripts/remit.mjs sign plan.json --detach`. It returns a 127.0.0.1 link at once.
   Give them the link and tell them to press the button and confirm in their wallet. You never sign or send.
4. When they say it's done: `node scripts/remit.mjs status plan.json`. "PAID" means mined, succeeded, and
   recipient/value/input match the plan. Give the explorer link.

Other commands:
- `read <invoice>`: just what was lifted off the document and the paper flags, no network.
- `paid <tx hash> plan.json`: checks any mined transaction against a plan.

## Rules

- Only PROS, WPROS and USDC on Pharos mainnet. "$" or "USD" is a question for the issuer, not a token.
- No OCR. A PNG without a QR code, or a PDF without text, is UNREADABLE: ask for the original file or a payment link.
- If the user pastes an invoice, save it to a temp file or pass the text in quotes.
- A STOP from the chain check (TOKEN_NOT_ON_CHAIN, NOT_ENOUGH_FUNDS, WOULD_REVERT) is about the payment, not the
  invoice: say what the chain answered.
