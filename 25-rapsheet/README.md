# 25 · Wallet Risk Checker

**rapsheet** is an agent skill that pulls an address's record before you pay it, approve it or call it, and says in
plain words what should make you hesitate. You get LOW, MEDIUM or HIGH with numbered reasons. Every finding links to
the transaction, block or address on pharosscan that proves it.

Three things set it apart:

- **It reads the whole history, not a window.** Pharos has no "transactions by address" call and caps `eth_getLogs`
  at 1,000 blocks, so a checker built only on logs sees a few hours. rapsheet uses the socialscan explorer behind
  pharosscan as an index of the address's whole life: when it was created, who paid for its first gas, what it
  approved. It then checks the facts a verdict leans on against the chain itself. When the two disagree, the card
  says so. On the risky contract below, pharosscan still shows an implementation that the chain has replaced.
- **"Verified code" is a real check.** The explorer's profile endpoint says whether the source is verified, and
  rapsheet asks it about the code behind a proxy, not about the shell.
- **Risk depends on who asks.** With `--me <your wallet>` it also reads your history. It checks:
  - whether this is your first contact with the address;
  - whether the address shares the first and last four characters of someone you paid (address poisoning);
  - whether the address sent you zero or dust transfers to plant itself in your history.

Read-only: no key, no `.env`, nothing is signed or sent.

## Quick start

```bash
cd 25-rapsheet && npm ci && npm run build && npm test
node skill/rapsheet/scripts/rapsheet.mjs 0x04a6dd7907fff325c580dc84829f0379de49dc22
node skill/rapsheet/scripts/rapsheet.mjs 0xc879c018db60520f4355c26ed1a6d572cdac1815 --me <your wallet>
```

| Flag | What it does |
|---|---|
| `--me <wallet>` | Adds the checks from your own history. |
| `--watchlist list.json` | Takes your own list of `{"address","reason","source"}`. rapsheet ships with no list: we know of no public blacklist for Pharos and won't invent one. |
| `--window <blocks>` | How far back to scan for approvals that name the address. Default 100,000 blocks, about 26 hours. |
| `--json f` / `--md f` | Also writes the report as JSON or Markdown. |

The exit code is 0 for LOW, 1 for MEDIUM, 2 for HIGH and 3 when the check could not run. Another agent can put
rapsheet in front of a send and stop on 2.

The skill is in `skill/rapsheet/`: SKILL.md plus one bundled script, so the user needs nothing but node. SKILL.md
tells the agent four things:
- what to ask: the address, and the user's wallet for `--me`;
- how to retell the card: the level first, then what eases a flag, then what was not checked;
- never to call anyone a scammer: the card names patterns, not people;
- to give a concrete next step on HIGH.

## The checks

**For a contract:**

| Check | How | Flag |
|---|---|---|
| How old it is | Creation tx from the explorer, confirmed on chain: no code one block before, code from that block on. | HIGH under 3 days, MEDIUM under 14 |
| Can anyone read the code | Verified source on pharosscan, for the implementation behind a proxy. Bytecode identical to verified contracts counts as readable. | MEDIUM if unverified |
| Can its code be swapped | EIP-1967 and the older ZeppelinOS slots that USDC uses, read on chain; then the proxy admin or `owner()`. | MEDIUM if one plain wallet controls upgrades |
| Has its code been swapped | Binary search on the implementation slot finds the block where today's code went in, then the Upgraded event in that block. About 25 storage reads. | HIGH if swapped within 7 days and unverified, MEDIUM if swapped after launch |
| What its owner can do | PUSH4 selectors in the bytecode: mint, pause, blacklist, fees, limits, upgrade, withdraw. | note |
| Who has approved it | Approval events naming it in the window. This is what is at stake, since approvals stay open across upgrades. | note |

**For a wallet:**

| Check | How | Flag |
|---|---|---|
| How long it has existed | First transaction or funding, whichever came first. | MEDIUM under 2 days or no history at all |
| Who paid for its first gas | Funding tx from the explorer, nonce from the chain. | MEDIUM if funded in the last 48 h and 3 txs or fewer sent |
| What the funder was doing | The funder's sends within an hour of funding this wallet. A busy, long-lived funder, such as an exchange, gets a note only. | MEDIUM if it seeded 10 or more wallets |
| Approvals it left open | Latest 40 approve txs; each allowance read on chain today. | HIGH if open to a plain wallet; MEDIUM if unlimited to an unverified or young contract (eased when the wallet deployed that contract itself) |
| Who lets it move their tokens | Approval events naming this wallet as spender in the window, each allowance re-read on chain. | HIGH if anyone's approval to it is still open |

**From your own history (`--me`):**

| Check | Flag |
|---|---|
| First contact | note |
| Looks like someone you paid | HIGH |
| Sent you dust or zero | MEDIUM, HIGH together with a look-alike |

**Verdict rule:**
- One HIGH flag, or three MEDIUM flags, make it **HIGH**.
- One or two MEDIUM flags make it **MEDIUM**.
- Otherwise it is **LOW**.

"On the other hand" notes are shown next to a flag but never change the count. Whatever could not be checked is
listed, so LOW reads as "nothing found in what was checked", never as "safe". Red flags are reasons to stop and
look, not proof of a crime.

## Proof

All runs are on Pharos mainnet with the bundled skill script, on 2026-11-10 (UTC). Full cards are in
[`proof/`](proof), each with `.md` and `.json` copies.

**How the risky examples were found.** We did not create them on a testnet. [`tools/scout.mjs`](tools/scout.mjs)
sweeps the last 100,000 blocks for two patterns:
- plain wallets named as the spender in an Approval;
- proxies upgraded more than a day after they were created.

Its output is [`proof/00-scout.txt`](proof/00-scout.txt): 3,789 Approval events naming 54 spenders, one of them a
plain wallet, and 117 Upgraded events, of which 4 proxies were upgraded late. Anyone can run it again and get
today's candidates.

**Clean contract: [WPROS](https://www.pharosscan.xyz/address/0x52c48d4213107b20bc583832b0d951fb9ca8f0b0), LOW**
([card](proof/01-clean-contract-wpros.txt)):
- created 10 months ago, in block 1617294;
- verified;
- both proxy slots empty;
- none of the usual owner switches in its bytecode.

**Clean wallet: [our test wallet](https://www.pharosscan.xyz/address/0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb), LOW**
([card](proof/02-clean-wallet.txt)):
- first transaction 6 months ago;
- 580 transactions sent since;
- of 7 approvals looked up on chain, 2 still open: none to a plain wallet, and no unlimited one to an unverified or
  young contract;
- nobody approved it in the window.

**Risky contract: [0x04a6…dc22](https://www.pharosscan.xyz/address/0x04a6dd7907fff325c580dc84829f0379de49dc22), HIGH, 3 red flags**
([card](proof/03-risky-contract.txt)):
1. The code running today went in at block 22622345, in tx
   [0x0570…9558](https://www.pharosscan.xyz/tx/0x05708140b33ae9d712ab9920672db3f7b15497c12325be05a550cff12daa9558),
   20 days after the contract went live. pharosscan still shows the older implementation 0xafbe…60ac; the chain slot
   says 0xc404…7e0e.
2. That new code is not verified.
3. Its `owner()`, which controls upgrades, is a plain wallet,
   [0x54f8…5ff4](https://www.pharosscan.xyz/address/0x54f856b5837aad58267fa6c37f901fa79b465ff4): one private key.

The note under it shows what is at stake: in the same 26 hours, 71 wallets approved it, and all 109 of those
approvals were unlimited.

**Risky wallet: [0x19d2…466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e), HIGH, 2 red flags**
([card](proof/04-risky-wallet.txt)):
1. Another wallet,
   [0xa95f…d91b](https://www.pharosscan.xyz/address/0xa95f856f2835ae2a61b2360b3de4f0ff2b39d91b), approved this plain
   wallet to move its USDC in tx
   [0xc76f…2cec](https://www.pharosscan.xyz/tx/0xc76fd41aa7c2de16c20afae1a13360102db155406176b4b21337f506e9272cec),
   and the allowance is still open on chain.
2. The wallet itself has never made a transaction.

Apps take approvals through contracts. A bare wallet holding someone else's approval is the shape of an approval
drain. This proves no theft, and the card does not claim one.

**Asked by you: [USDC](https://www.pharosscan.xyz/address/0xc879c018db60520f4355c26ed1a6d572cdac1815) with `--me` set to our test wallet, MEDIUM**
([card](proof/05-usdc-asked-by-you.txt)):
- USDC is a ZeppelinOS-style proxy whose admin slot holds a plain wallet,
  [0x46f9…3f1b](https://www.pharosscan.xyz/address/0x46f958bdeffd33495e058873cdd114c79ec13f1b), so one key can swap
  the code;
- the implementation is verified and unchanged since creation;
- its bytecode has mint, pause and blacklist;
- from our history: we dealt with it 38 times before, and none of the 52 addresses we paid look like it.

A checker that only knows the EIP-1967 slot would call USDC "not upgradeable".

### Requirements → evidence

| # | Arena requirement | Where |
|---|---|---|
| 1 | At least 4 signals | 6 contract checks, 5 wallet checks, 3 from your own history, plus an optional watchlist (tables above) |
| 2 | Risk level with the specific reasons | `RISK: LOW/MEDIUM/HIGH` plus numbered reasons at the end of every card in `proof/` |
| 3 | Each flag in plain language | Each line says what was seen, "Why it matters", any "On the other hand", and the link |
| 4 | At least 1 clean and 1 risky example | 2 clean (01, 02), 2 risky (03, 04) and one MEDIUM (05), all real mainnet addresses |

## Limits

- **Explorer index.** The explorer lists at most 10,000 rows per kind. rapsheet reads the latest 3,000 transactions
  of a wallet and says when it stopped early.
- **Approvals naming an address are scanned only in a recent window.** No index lists them by spender. The card
  says how far back it looked.
- **The funder heuristic is a heuristic.** A wallet funded through a contract (a bridge or a faucet) gets a note
  only.
- **Selectors in bytecode are hints.** A function can exist under another name.
- **Who controls a proxy is checked only through the admin slot and `owner()`.** rapsheet doesn't tell a multisig
  from a timelock.
- **No dollar values and no blacklist.**
- **13 tests** run against a fake chain and explorer: `npm test`.
