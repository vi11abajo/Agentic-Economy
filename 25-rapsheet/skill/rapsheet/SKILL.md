---
name: rapsheet
description: >
  rapsheet: before you pay, approve or call an address on Pharos mainnet, it pulls that address's whole record and
  says in plain words what should make you hesitate. For a contract it checks:
    - its age, read from the chain;
    - whether its code is verified;
    - whether it is a proxy, and whether one private key can swap its code;
    - whether that code was already swapped, and when;
    - what owner switches its bytecode has;
    - how many wallets have approved it.
  For a wallet it checks:
    - its age;
    - who paid for its first gas, and whether that funder was seeding a crowd of new wallets;
    - which approvals it left open;
    - whether other people gave it approvals, which is the drainer's side.
  With the user's own wallet it also checks first contact, look-alikes of addresses they paid (address poisoning)
  and dust sent to them. The result is LOW, MEDIUM or HIGH with numbered reasons, and every finding links to its
  evidence on pharosscan. It is read-only: it uses no key, and nothing is signed or sent. Use it when someone asks
  whether an address, wallet, contract, token or spender is safe or legit, or wants it checked before sending
  money, approving or interacting.
version: 1.0.0
requires:
  anyBins:
  - node
---

# rapsheet

The command is `node scripts/rapsheet.mjs <address> [--me <their wallet>] [--watchlist list.json] [--window blocks] [--json f] [--md f]`.
Below it is just `rapsheet`. It needs nothing but node: no install, no key, no `.env`.

## What to ask first

- **The address to check.** It is required. Take it exactly as the user gave it. If they pasted it from somewhere,
  check with them that it really is the one they mean.
- **Their own wallet, for `--me`.** This is optional but worth one short question when they're about to pay
  someone, because only their history shows a look-alike of an address they paid before. If they say no or don't
  know, run without it.
- **A watchlist.** Only use one if the user already has a list of bad addresses. Don't make one up. rapsheet ships
  with none, because no public blacklist for Pharos is known to us.

## Running it

- The command is `rapsheet <address> --me <wallet>`.
- A run takes 10 to 30 seconds. It reads the explorer and about a day of approval logs.
- Exit code 0 means LOW, 1 MEDIUM, 2 HIGH, and 3 means it couldn't check. With 3, give the user the error line as it
  is and don't guess a verdict.

## Telling the user what came out

1. **Lead with the level and why.** Say the level, then the numbered red flags in your own plain words. Keep each
   number, block and date from the output, and put the link next to the claim it proves.
2. **Mention what eases a flag, but don't let it cancel one.** If a flag has an "On the other hand" line, say it
   too. For example: "the wallet deployed that contract itself".
3. **Say what wasn't checked.** If the card has a "Not checked" line, say what was left out. A LOW is never "safe",
   only "nothing found in what was checked".
4. **Never call anyone a scammer or a drainer.** The card names patterns. "This looks like how approval drainers
   collect" is fine. "This is a scammer" is not.
5. **On HIGH, give a concrete next step.** Don't send or approve. Get the address again from the source. For an
   approval, approve only the exact amount.

## What the checks mean

- **Contract age.** It comes from the creation transaction, checked on the chain: no code one block earlier, code
  from that block on.
- **Can anyone read the code.** Verified source on pharosscan. For a proxy this is checked on the code behind it,
  not on the shell. Bytecode identical to verified contracts counts as known source, and gives only a note.
- **Can its code be swapped.** Both EIP-1967 proxies and the older ZeppelinOS layout that USDC uses are detected.
  If the proxy admin or `owner()` is a plain wallet, one private key controls the code.
- **Has its code been swapped.** This finds the block where today's implementation was put in, by binary search on
  the chain. If pharosscan still shows an older implementation, the card says so.
- **What its owner can do.** Selectors found in the bytecode: mint, pause, blacklist, fees, limits, upgrade,
  withdraw. They are hints, not proof.
- **Who has approved it.** How many wallets approved it in the scanned window. This is what is at stake, and it is
  a note, not a flag.
- **Wallet age, first gas and the funder.** One funder paying many new wallets within an hour is how farms and
  drainer crews set up their accounts. A busy, long-lived funder (an exchange, say) gets only a note.
- **Approvals it left open.** It reads the latest approve transactions and checks each allowance on the chain
  today. One still open to a plain wallet is HIGH.
- **Who lets it move their tokens.** These are approvals naming this wallet as spender, found in the scanned
  window. A plain wallet holding open approvals from others is HIGH.
