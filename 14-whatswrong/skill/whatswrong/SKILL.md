---
name: whatswrong
description: >
  whatswrong: explains why a transaction on Pharos mainnet failed and checks the fix. Give it a tx hash: it reads
  the transaction and receipt through Pharos Chain MCP, replays it, follows the call trace to the contract that
  really said no (a token, a pool, a vault), decodes the reason, and names the kind of failure (out of gas,
  slippage, expired deadline, missing approval, not enough balance, a vault without cash, a transaction beaten in
  the same block, no permission). Then it rebuilds the transaction the way the fix says and replays it, so the
  advice is checked, not guessed. Use when the user shares a failed or reverted transaction hash on Pharos, asks
  why a swap, buy, sell, deposit or withdrawal failed, or what to do about a failed transaction.
requires:
  anyBins:
  - node
---

# whatswrong

Run with Node 20+ from this skill's folder: `node scripts/whatswrong.mjs <tx hash>` (use the absolute path of
`scripts/whatswrong.mjs` from elsewhere). One bundled file, no install, no keys. It only reads; it never signs or
sends anything.

| Command | What you get |
|---|---|
| `whatswrong <tx>` | the fact sheet: what broke, where, why, and whether the checked fix goes through |
| `whatswrong <tx> --quick` | the diagnosis only, without the fix check |
| `whatswrong <tx> --json` | the same facts as JSON |

## How to answer the user

1. Run it on the hash they gave. Read the whole sheet; never cut it with head/tail/grep.
2. Answer in the user's language, in plain words, as if to someone who doesn't know what a revert is. No
   selectors, no "execution reverted", no hex unless they ask. Three short parts:
   - **What happened**: one or two sentences (e.g. "the swap was cancelled because the price moved before it
     went through and you'd have received less than your minimum").
   - **Why**: the facts behind it, in human units from the sheet (amounts with token names, how many blocks
     earlier, how much cash the vault had).
   - **What to do**: the fix. Say whether whatswrong checked it and what came out. "fix works" / "fix fails" mean
     a patched copy of the transaction was replayed (the sheet says whether on today's state or at the moment it
     was sent); a "then" line is the next problem the patched copy hit, explain that one too. "looked up: ok" /
     "looked up: short" mean nothing was replayed, a balance or a vault's cash was just read.
3. Use the sheet's own clues for the story: `left before` (the same tokens already left the wallet earlier,
   usually a repeated send), `same block` (a transaction just before it in the same block probably changed the
   price; if it's the same sender, say it was most likely their own earlier transaction), `now` (whether simply retrying
   would work today).
4. Don't claim more than the sheet shows. If the kind is `other_revert` or a reason is `unknown`, say what is
   known (which contract refused, the reason text if any) and that the exact cause can't be named.
5. Give the pharosscan link from the sheet so they can look themselves.
6. Never ask for a private key or seed, and never offer to send a transaction for them.

## Kinds

`out_of_gas`, `slippage`, `deadline`, `allowance`, `balance`, `vault_liquidity` (an ERC-4626 vault didn't have
the idle cash to pay out), `contract_short` (some other contract paying out, a router or a market, came up short),
`same_block` (fine just before the block, failed inside it: probably something earlier in that block changed the
price or the state, the sheet lists candidates but can't prove which), `unauthorized`, `deployment_failed`,
`other_revert`, and `not_failed` (the transaction didn't fail at all).
