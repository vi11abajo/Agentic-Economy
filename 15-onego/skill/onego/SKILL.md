---
name: onego
description: >
  onego: does several things on Pharos mainnet in ONE transaction from a plain wallet, without giving anyone
  rights to it (no approve, no EIP-7702 delegation). It can send PROS, send USDC (by the payer's own EIP-3009
  signatures), and buy Prosper tokens with PROS (from their V2 pool or their bonding curve), any mix of them,
  in one Multicall3 transaction. Before anything is signed it simulates the whole batch on mainnet and shows
  what each action would do, what Multicall3 would keep (must be nothing), and gas and steps compared with
  sending them one by one. Use when the user wants to pay several people, airdrop to several wallets, or buy
  several Prosper tokens at once, "in one transaction", "in one go", "as a batch".
requires:
  anyBins:
  - node
---

# onego

Run with Node 20+ from this skill's folder: `node scripts/onego.mjs <command>` (use the absolute path of
`scripts/onego.mjs` from elsewhere). One bundled file, no install.

| Command | What it does |
|---|---|
| `onego recipients --recent 10` | the 10 latest plain wallets (no code) seen sending in recent blocks |
| `onego check plan.json` | simulates the whole batch on mainnet; no key needed |
| `onego check plan.json --what-if-pros 20 --what-if-usdc 1` | the same with made-up balances |
| `onego send plan.json` | checks again, signs with the key in `.env`, sends, verifies on chain |
| `onego cancel <result file>` | voids USDC signatures a send left unused |
| `onego setup` | where the data folder and `.env` are, and whether a key is there (address only) |

Add `--json` for machine-readable output. Exit codes: 0 done, 1 error, 2 bad plan or no key, 3 refused or reverted.

## Turning the request into a plan

Write a plan file and run `check` on it. Ask the user for anything missing (amounts, addresses, which wallet
pays); never guess an address.

```json
{
  "wallet": "0x...the paying wallet",
  "actions": [
    { "kind": "send_usdc", "to": "0x...", "amount": "0.00001" },
    { "kind": "send_pros", "to": "0x...", "amount": "1" },
    { "kind": "buy", "token": "pTACO", "pros": "5" },
    { "kind": "buy", "token": "0x...token", "pros": "5", "market": "0x...curve market, only if onego can't find it" }
  ]
}
```

- "The latest wallets", "fresh wallets from recent blocks": run `recipients --recent <n>` first and put the
  addresses it prints into `send_usdc` / `send_pros` actions. Mention that it skips contracts and wallets
  delegated through EIP-7702.
- Amounts are in human units ("0.00001" USDC, "5" PROS). USDC has 6 decimals: smaller amounts are refused, not
  rounded.
- PROS goes to plain wallets only. A contract may book the PROS for whoever called it, and inside the batch
  that's Multicall3, so onego refuses PROS sends to any address with code.
- Things onego refuses, and why (say it in those words): selling a token, swapping USDC or any ERC-20, sending
  p-tokens. All of them need the wallet to approve someone first, and onego never gives anyone rights to it.

## How to answer the user

1. Always run `check` before anything else and read the whole table. Explain it in plain words, in the user's
   language:
   - each action: what goes where and what it gets ("pTACO: about 579 tokens for 5 PROS");
   - "Left in Multicall3: nothing" means nothing of theirs stays in the middle;
   - the comparison: say it as it is. "1 transaction instead of 7, 20% less gas" or "1 transaction instead of
     10, but 12% more gas: each USDC payment by signature costs a bit more than a plain transfer";
   - every warning (a Prosper curve that failed its goal, a curve taking less PROS than asked);
   - the verdict. If it's NOT sendable, explain each reason and how to fix the plan.
2. Run `send` only when the user tells you to send, in that turn. Never on your own.
3. After `send`, give the transaction link and the per-action outcome (amounts are read from the chain after
   mining). If a USDC payment failed inside the batch, or a send was refused after its check, the signatures
   stay valid until the time printed; offer `onego cancel <result file>`.
4. If `send` exits with code 1 (a network error), never run it again straight away: it prints the hash and
   saves it under `sends/` before broadcasting. Look the hash up on pharosscan first; sending again could pay
   everyone twice.

## Failure rules (what the user should know)

- Anything that carries PROS (a buy or a PROS send) can't fail alone: if one fails, the whole transaction
  reverts and all PROS stays in the wallet. Only gas is spent.
- USDC payments can fail alone: the others still go, and onego names who wasn't paid and why.
- Nothing is sent if the fresh check right before sending finds any failure, so a moved price or a spent
  balance stops it before signing.

## Key and wallet

- The key lives only in `.env` in the data folder (`setup` prints where). The user writes `PRIVATE_KEY=0x...`
  there themselves. Never ask for it in the chat, never write it into a command, never read or print the file.
  If the user pastes a key anyway, don't use it: tell them it's now exposed and they should move funds to a
  fresh wallet.
- Suggest a small wallet that holds only what the batch needs.
