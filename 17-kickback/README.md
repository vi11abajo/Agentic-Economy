# 17 · Skill + Chain MCP Flow

**kickback** is an agent skill that hands out a bonus cashback to people who recently bought Prosper tokens on
Pharos mainnet, and does it so fairly that nobody has to trust whoever runs it. You ask once ("send a bonus
cashback to 3 random people who bought Prosper tokens lately"), and one command does the rest: it finds the last
30 real buyers through the Pharos Chain MCP, writes that list and the rule on chain, waits for a block that
didn't exist yet, lets that block's hash pick the winners, pays them, and checks every payout on chain.

The skill makes every decision; the Chain MCP supplies every fact and carries every transaction. The winners
literally can't be known until a future block is mined, so the skill's answer depends on live chain data in the
strongest way there is.

The full flow (what calls what, in order) with a diagram: [ARCHITECTURE.md](ARCHITECTURE.md). Design notes:
[docs/superpowers/specs/2026-11-04-kickback-design.md](../docs/superpowers/specs/2026-11-04-kickback-design.md).

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
the hash of block commit + delay, redoes the draw, and finds the USDC payouts in the logs (for PROS payouts pass
their tx hashes too, plain PROS transfers leave no logs). It answers MATCH or the first difference.

## Limits

- The validator producing the deciding block could in theory influence its hash. kickback protects the
  participants from whoever runs the draw, not from the chain itself.
- "Buyer" means a buy on Prosper's V2 pairs. Buys on the bonding curve and on other DEXes aren't counted.
- A payout that keeps failing in simulation is marked FAILED; no replacement winner is drawn.
- Pharos mainnet only. The Chain MCP allows 120 calls a minute; the 30-person dry run above took 94 calls and
  53 seconds before the point where the commit would go out.

## Tests

`npm test` in this folder: 59 tests. The buyer search replays a tape of real Chain MCP answers recorded on
2026-11-04 (`test/tapes/buyers.json`, made by `test/record.mjs`); the full draw, crashes and resume run on a small
fake chain that really decodes and applies the signed transactions.

## Proof

Filled after the recorded run.
