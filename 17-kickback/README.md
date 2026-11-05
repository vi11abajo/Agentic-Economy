# 17 · Skill + Chain MCP Flow

**kickback** is an agent skill that hands out a bonus cashback to people who recently bought Prosper tokens on
Pharos mainnet, and does it so fairly that nobody has to trust whoever runs it. You ask once ("send a bonus
cashback to 3 random people who bought Prosper tokens lately"), and one command does the rest: it finds the last
30 real buyers through the Pharos Chain MCP, writes that list and the rule on chain, waits for a block that
didn't exist yet, lets that block's hash pick the winners, pays them, and checks every payout on chain.

The skill makes every decision; the Chain MCP supplies every fact and carries every transaction. The winners
literally can't be known until a future block is mined, so the skill's answer depends on live chain data in the
strongest way there is.

The full flow (what calls what, in order) with a diagram: [ARCHITECTURE.md](ARCHITECTURE.md).

## Why a fair draw

The usual "skill + chain data" demo is a yes/no check: can I afford this transfer, is this payment settled. I
wanted the chain to do more than feed a threshold. In a draw the chain is the judge: it supplies the people
(real buyers from Swap logs), it holds the promise (the commit tx), and it rolls the dice (a block hash nobody
could know in advance). And then anyone can replay the whole thing from one tx hash.

## Who is in the draw

Prosper's tokens trade on Prosper's own V2 pairs once they leave the bonding curve; right now there are 10, all
WPROS against a p-token. A buyer is whoever got p-tokens out of a swap that put
WPROS in. I check every buyer's address with `get_code`: routers and bot contracts are skipped, so are repeats and
the wallet running the draw. The curve itself barely trades anymore, so its buyers would make a thin pool. In a
dry run on 2026-11-04 the V2 pairs gave 30 different buyers between blocks 22107085 and 22134084.

## Quick start

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/17-kickback/skill/kickback
```

Then ask your agent. Or run it yourself with Node 20+:

```bash
node skill/kickback/scripts/kickback.mjs setup
node skill/kickback/scripts/kickback.mjs draw --dry
node skill/kickback/scripts/kickback.mjs draw --winners 3 --amount 0.00001
node skill/kickback/scripts/kickback.mjs verify <commitTx>
```

The data folder is `KICKBACK_HOME`, or `%APPDATA%\kickback` / `~/.config/kickback`. Put `PRIVATE_KEY=0x...` into
its `.env` yourself; kickback never asks for the key anywhere else and never prints it. Signing is local, sending
goes through the Chain MCP's `send_raw_transaction`.

## Parameters and caps

| Flag | Default | Allowed |
|---|---|---|
| `--pool` | 30 | 2..100 people |
| `--winners` | 3 | 1..10, fewer than the pool |
| `--amount` | 0.00001 | per winner |
| `--token` | USDC | USDC or PROS |
| `--delay` | 5 | 1..50 blocks between the commit and the deciding block |

The agent picks these out of the request ("5 lucky people from the last 50 buyers, in PROS"). What it can't do
is go over the caps in `config.json` in the data folder (`max_total_usdc` 0.0001 and `max_total_pros` 0.001 by
default, plus a 50,000-block look-back). Only you edit that file. Anything over the cap stops the run before a
single thing is signed.

## Checking a draw

```
kickback verify <commitTx>
```

It needs nothing but the hash: the list and the rule are inside the commit tx. It reads the commit block, gets
the hash of block commit + delay, redoes the draw, and finds the USDC payouts in the logs of the 2,000 blocks after
it. Payout hashes from the draw report can be passed too: PROS payouts need them (plain PROS transfers leave no
logs), and so does a USDC draw that was resumed long after the target block. It answers MATCH or the first difference.

## Limits

- The validator producing the deciding block could in theory influence its hash. kickback protects the
  participants from whoever runs the draw, not from the chain itself.
- "Buyer" means a buy on Prosper's V2 pairs. Buys on the bonding curve and on other DEXes aren't counted.
- A payout that keeps failing in simulation is marked FAILED; no replacement winner is drawn.
- One process per draw: a second `draw --resume` on a draw that is still running refuses to start.
- Pharos mainnet only. The Chain MCP allows 120 calls a minute; the 30-person dry run above took 94 calls and
  53 seconds before the point where the commit would go out.

## Tests

`npm test` in this folder: 63 tests. The buyer search replays a tape of real Chain MCP answers recorded on
2026-11-04 (`test/tapes/buyers.json`, made by `test/record.mjs`); the full draw, crashes and resume run on a small
fake chain that really decodes and applies the signed transactions.

## Proof

Recorded for the walkthrough video on 2026-11-04 (23:47 to 23:53 UTC): an agent installed the skill from this repo
and ran two draws from plain-English requests, paying from a small test wallet
(0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb). After each draw it ran `kickback verify` on the commit tx, and both
answered `MATCH: the winners follow from the committed list and the block hash, and each one was paid`. The numbers
below are copied from that run.

**Draw 1:** "send a bonus cashback of 0.00001 USDC to 3 random people out of the last 30 buyers"

- Pool: 30 buyers on the Prosper V2 pairs, blocks 22110648..22136647 (snapshot 22136647), 0 contracts skipped.
- Commit [0xa8af5d14…604b](https://www.pharosscan.xyz/tx/0xa8af5d14dd0dfe35c180b4c961fd1c16399ee2ffecd70b1e3a08c04f1021604b), block 22136706.
- Target block 22136711 (commit + 5), hash `0x0d0385665696362b0ac74eff9d936ee606bb01c0e319e1059c4b129877484fdf`.
- Winners, 0.00001 USDC each:
  - 0x5c6ae2fbbe12720e075a8dff9d39b440ce26de82 in [0x4b556c22…6277](https://www.pharosscan.xyz/tx/0x4b556c22159d94dd794083998f6d23081d97fecebff44e90e6653da283c76277)
  - 0xcc1e28073b2ab93b6053cc96f1f0d41e7cb85632 in [0x8da38db7…0af0](https://www.pharosscan.xyz/tx/0x8da38db7113c4b855fea14ec4c6f4cf054680b5477f940bae56aa9d1f0360af0)
  - 0x35717f33fa679575c0fb9d5d6fbbfd0322dd6812 in [0x7f075734…77e7](https://www.pharosscan.xyz/tx/0x7f0757343342bec9ecdbdbc1902a6cfdb3f2e70a9f4230ae54072e405a6477e7)
- 125 Chain MCP calls from the snapshot to the last payout check.

**Draw 2:** "one more round: 2 lucky people from the last 50 buyers, 0.00002 USDC each, and wait 8 blocks this time"

- Pool: only 39 buyers in the 50,000-block look-back (22086818..22136817), 2 contracts skipped. kickback said so and
  drew from those 39; the commit records 39.
- Commit [0x6d14d16a…d54e](https://www.pharosscan.xyz/tx/0x6d14d16a8d2fa09a633aee5b3c18ce67cd33a95c19d82e417952637ede05d54e), block 22136890.
- Target block 22136898 (commit + 8), hash `0x9296730968b1bea30f6e70084ffe35a0c3c27dc90386dd2cca5c85ec146cc6be`.
- Winners, 0.00002 USDC each:
  - 0xffe3b944e628a36e10f06f872dbd46fc30167732 in [0xa0c1671b…080f](https://www.pharosscan.xyz/tx/0xa0c1671b040eea93368c4cfe24c92835b137079061e0d78290c785c4f562080f)
  - 0xa97f27bd0a0be4755a1f01c47ed7e5db84cf2609 in [0x477abd8f…dbf5](https://www.pharosscan.xyz/tx/0x477abd8f7c73409e5dd831e77941009618dceb4c724377c1ae188b64cce7dbf5)
- 155 Chain MCP calls.

Check either one yourself:

```bash
node skill/kickback/scripts/kickback.mjs verify 0xa8af5d14dd0dfe35c180b4c961fd1c16399ee2ffecd70b1e3a08c04f1021604b
```
