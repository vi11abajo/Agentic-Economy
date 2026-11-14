# 27 · Invoice-to-Payment Agent

**remit** is an agent skill that reads an invoice and prepares the matching payment on Pharos mainnet. It reads JSON,
plain text or Markdown, PDF, and PNG payment QR codes. You get a plain summary and an unsigned transaction with the
invoice number written into it. When something is off, remit tells you what and where instead of filling the gap.

It doesn't stop at the paper. Before it calls a plan ready, it asks the chain three things:
- is the token contract really there, and is it the token it claims to be;
- has this exact invoice already been paid to this payee;
- would this exact transaction go through from your wallet right now.

remit holds no key. You sign in your own browser wallet, on a page that checks everything again first.

## Quick start

```bash
cd 27-remit && npm ci && npm run build && npm test
node skill/remit/scripts/remit.mjs read samples/03-audit.pdf
node skill/remit/scripts/remit.mjs plan samples/04-checkout-qr.png --from <your wallet> --out plan.json
node skill/remit/scripts/remit.mjs sign plan.json --detach      # prints a 127.0.0.1 link, your wallet signs
node skill/remit/scripts/remit.mjs status plan.json             # what the page saw: PAID, or why not
node skill/remit/scripts/remit.mjs paid <tx hash> plan.json     # check any mined tx against a plan
```

Exit codes: 0 fine, 2 flagged (nothing to pay), 1 broken input. An agent can stop on 2.

## What it reads

| Format | How | What it won't do |
|---|---|---|
| JSON e-invoice / ERP export | `invoiceNumber` or `reference`, `payee`, `currency`, `items`, `subtotal`, `tax`, `total` | invent a field the export left out |
| Text or Markdown | labelled lines (`Invoice #:`, `Pay to:`, `Total:`), Markdown tables as line items | read prose like "send it to my usual address" |
| PDF | the text layer, straight from the deflated content streams with zlib | OCR a scan: a PDF with no text layer comes back UNREADABLE |
| PNG with a QR code | decodes the QR (jsQR), then reads an [EIP-681](https://eips.ethereum.org/EIPS/eip-681) payment link | read text off pixels: a guessed digit in an address is exactly what this tool is for |

EIP-681 has no field for an invoice number, so remit reads an extra `ref=` parameter:
`ethereum:<USDC>@1672/transfer?address=<payee>&uint256=100000&ref=INV-2026-QR-0042`. A link without one is flagged.

## The paper check

Everything here runs without the network. A STOP means no plan.

| Flag | When |
|---|---|
| `MISSING_FIELD` | no reference, payee, token or total |
| `MATH_MISMATCH` | line items don't add up to the subtotal, or subtotal + tax - discount isn't the total; more decimals than the token has |
| `AMBIGUOUS_CURRENCY` | "$", "USD", "dollars": could be USDC, a bridged USDC or a bank wire, so remit won't pick |
| `UNSUPPORTED_TOKEN` | anything but PROS, WPROS, USDC |
| `INVALID_PAYEE` | not an address, or a mixed-case address whose checksum fails (that's how a one-character typo shows up) |
| `DANGEROUS_PAYEE` | the zero address, a token contract, or one of the ten default Hardhat/Anvil accounts whose keys everyone has |
| `WRONG_CHAIN` | a QR payment link made for another chain (`@1` is Ethereum) |
| `EXPIRED_INVOICE` | past the due date (a warning with `--allow-expired`) |
| `UNREADABLE` | no QR code in the picture, no text in the PDF |

## The chain check

With the network on (the default), `plan` reads Pharos mainnet through `rpc.pharos.xyz`:

- **The token is real.** It reads the contract code, `symbol()` and `decimals()` and compares them with remit's
  three-token list. I added this after finding a WPROS address in an earlier draft that has no code at all: a
  `transfer()` there "succeeds" and moves nothing.
- **Already paid?** It asks the explorer index behind pharosscan for the payee's recent incoming payments. For each
  one in the same token it reads the transaction input on chain and looks for `INV:<reference>`. A match that
  succeeded is `ALREADY_PAID`, with the tx link. The explorer only nominates candidates; the verdict comes from the chain.
- **With `--from`:** your balance of the token, then `eth_estimateGas` for the exact transaction from your address.
  If Pharos would reject it, you hear why now, not in your wallet. The gas limit is the estimate plus 20%.
- A payee that is a contract gets a warning, not a stop: multisigs and merchant vaults are normal.

## Where the reference goes

- **PROS:** a plain value transfer to a wallet ignores calldata, so the reference is the whole input: `INV:INV-2026-0419`.
- **USDC / WPROS:** `transfer(to, amount)`, then the reference bytes after the two arguments. Solidity decodes the
  arguments and never looks past them, so the call is unchanged and the reference stays in the tx input for good.

`remit paid <tx> plan.json` compares a mined transaction with the plan: recipient, value and the input byte for byte,
plus the receipt status.

## Signing

`sign` serves the plan on `127.0.0.1` only and refuses requests with any other Host header, so a page in another tab
can't drive it. When you press the button, remit:
1. checks the wallet is on Pharos (1672) and is the account the plan was checked for;
2. runs the whole thing again from the invoice file for that account at the latest block;
3. compares the fresh transaction with the plan file and refuses if they differ (a plan file is just a note on disk);
4. only then hands the transaction to your wallet, and after it's mined compares it with the plan again.

`--detach` starts the page as its own process and returns the link right away, for agents whose turn ends before you
reach your wallet. `status` reads what the page saw.

## Samples

`samples/make-samples.mjs` builds all of them, the PDF and the QR codes included, so you can see what's inside.
The valid ones pay cents to `0xa991…4348`, the x402 seller wallet from task 12 of this repo, so a real run fits a
small test wallet.

| File | remit says |
|---|---|
| `01-hosting.json` | 0.30 USDC, items add up |
| `02-freelance.md` | 0.004 PROS, table rows as items |
| `03-audit.pdf` | 0.15 USDC from the PDF text layer |
| `04-checkout-qr.png` | 0.10 USDC from an EIP-681 QR code |
| `05-totals-disagree.json` | STOP: 0.80 + 0.40 is not 0.90 |
| `06-no-reference.txt` | STOP: no invoice number |
| `07-just-dollars.json` | STOP: "$" isn't a token |
| `08-typo-in-address.txt` | STOP: checksum broken by one changed digit |
| `09-tutorial-address.txt` | STOP: Hardhat account #1, public key |
| `10-ethereum-qr.png` | STOP: the QR is for chain 1 |

## Layout

`src/parser/` one reader per format · `src/validator.ts` the paper check · `src/chain.ts` the chain check and the
paid check · `src/tx.ts` the unsigned transaction and the summary · `src/pipeline.ts` file to plan, used by `plan`
and again by `sign` · `src/sign.ts` the local signing page · `skill/remit/` SKILL.md plus one bundled script.
