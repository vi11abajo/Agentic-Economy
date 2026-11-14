# 28 · x402 Paywalled API

**turnstile** is a small API that charges per request with x402 on Pharos Atlantic testnet (`eip155:688689`), in
test USDC. It runs its own facilitator and comes with a buyer that shows every step of the payment. Then the buyer
goes to Atlantic and checks that the money really moved.

What it sells is real: live reads of Pharos mainnet. You pay testnet cents for actual data.

| Route | Price | What you get |
|---|---|---|
| `GET /health` | free | network, asset, who gets paid |
| `GET /catalog` | free | the price list |
| `GET /v1/pulse` | 0.001 USDC | Pharos mainnet right now: head block, seconds per block, gas price, base fee, how full the last 20 blocks were |
| `GET /v1/usdc-flows` | 0.005 USDC | every USDC transfer on mainnet in the last 1000 blocks: count, volume, mints, burns, the five biggest with tx links |
| `POST /facilitator/verify`, `POST /facilitator/settle`, `GET /facilitator/supported` | | the facilitator |

## Quick start

```bash
cd 28-turnstile && npm ci && npm run build && npm test
node skill/turnstile/scripts/turnstile.mjs balances --seller-env <seller .env> --buyer-env <buyer .env>
node skill/turnstile/scripts/turnstile.mjs demo --seller-env <seller .env> --buyer-env <buyer .env>
```

Or run the two sides apart:

```bash
node skill/turnstile/scripts/turnstile.mjs serve --seller-env <seller .env>              # http://127.0.0.1:4028
node skill/turnstile/scripts/turnstile.mjs buy http://127.0.0.1:4028/v1/pulse --buyer-env <buyer .env>
node skill/turnstile/scripts/turnstile.mjs buy http://127.0.0.1:4028/v1/pulse --mode underpay --buyer-env <buyer .env>
```

## Keys

No key is in the code, the prompts or the logs. turnstile reads them from the environment or from an env file you
point it at, and only ever prints addresses.

- **seller:** `SELLER_PRIVATE_KEY`. Receives the USDC and pays the settlement gas, so it needs a little Atlantic PROS.
- **buyer:** `BUYER_PRIVATE_KEY` (or `PRIVATE_KEY`). Only signs, so it needs test USDC and no PROS.

Keep both files outside the repo. `.env` and `.env.*` are git-ignored at the repo root anyway.

## How a purchase goes

1. `GET /v1/pulse` without paying gets **402** and a `PAYMENT-REQUIRED` header: scheme `exact`, network
   `eip155:688689`, asset Atlantic USDC, amount `1000` (0.001 USDC), `payTo`, and the EIP-712 domain to sign against.
2. The buyer signs an EIP-3009 `transferWithAuthorization` for exactly that, with the official `@x402` client. Its
   spend control is set to `--max` (0.01 USDC by default) and to this one asset, so it refuses to sign anything else.
3. It sends the same request again with `PAYMENT-SIGNATURE`. The server hands the payment to its facilitator
   (in-process, no HTTP hop to itself). The facilitator verifies it, the route runs, and then it settles on chain.
4. **200** with the data and a `PAYMENT-RESPONSE` header: `success`, the tx hash, network, payer.
5. The buyer reads that tx on Atlantic: receipt status, the `AuthorizationUsed` event for its own nonce, and the
   USDC `Transfer` to the seller. It prints the pharosscan link.

If the route fails (mainnet unreachable), it answers 5xx. The x402 middleware then cancels the settlement, so
nobody pays for data they didn't get.

## Bad payments

The demo tries two on purpose. Both come back as another **402** and nothing settles:
- **underpay:** a correct signature over one unit less than the price;
- **forged:** a correct payment with one byte of the signature changed.

The checks are the SDK's own (amount, recipient, asset, signature, time window, nonce not used, balance), run by the
real facilitator. The tests use that same facilitator, only on a pretend chain.

## The test USDC

Atlantic has two "USDC" contracts in the docs. turnstile uses `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B` from the
token registry. I checked it on chain:
- name `USDC`, version `2`, 6 decimals;
- its `DOMAIN_SEPARATOR` equals the one built from those values and chain 688689;
- it's a proxy whose implementation has `transferWithAuthorization`.

The one in the x402 guide (`0xE0BE…4ec8`, marked "not official" there) has no `transferWithAuthorization`, so x402
`exact` can't settle on it.

## Layout

`src/atlantic.ts` network facts · `src/keys.ts` env-file keys · `src/facilitator.ts` the facilitator and its HTTP
routes · `src/goods.ts` the mainnet reads that are for sale · `src/server.ts` the paywall · `src/buyer.ts` the
step-by-step buyer · `src/cli.ts` · `skill/turnstile/` SKILL.md plus one bundled script.
