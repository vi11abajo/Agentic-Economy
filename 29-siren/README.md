# 29 · On-Chain Alert Bot

**siren** watches Pharos mainnet and tells you on Telegram or Discord when something you care about happens:

- a token transfer above a size (USDC, WPROS, or any ERC-20 by address), optionally only from or to one address;
- the Chainlink PROS/USD feed going above or below a line;
- a successful call to a contract, by selector or by function signature, optionally only when it carries enough PROS.

Every alert says what happened, how much, and links to pharosscan. The same event never gets a second message,
not even after a restart.

## Quick start

```bash
cd 29-siren && npm ci && npm run build && npm test
node skill/siren/scripts/siren.mjs init       # makes siren's folder: .env + example rules.json
# paste your bot token and/or Discord webhook into that .env yourself, then:
node skill/siren/scripts/siren.mjs connect    # Telegram: after you sent /start to your bot
node skill/siren/scripts/siren.mjs test       # one test message per channel
node skill/siren/scripts/siren.mjs rules      # checks every rule on chain, shows the live price
node skill/siren/scripts/siren.mjs watch --since 4000   # first run: look back ~1 hour, then keep watching
```

siren's folder is `SIREN_HOME`, or `%APPDATA%\siren` on Windows and `~/.config/siren` elsewhere. It holds `.env`,
`rules.json` and `state.json`, all outside the repo.

## Rules

This is what `siren init` writes. The lines sit at about 5,000 PROS (some $2,300 that day): below that, on
2026-11-14 the rules mostly caught three wallets passing $500 back and forth.

```json
{
  "pollSeconds": 10,
  "rules": [
    { "name": "usdc-2500", "kind": "transfer", "token": "USDC", "min": 2500 },
    { "name": "wpros-5000", "kind": "transfer", "token": "WPROS", "min": 5000 },
    { "name": "pros-below-45c", "kind": "price", "feed": "PROS/USD", "below": 0.45 },
    { "name": "pros-above-50c", "kind": "price", "feed": "PROS/USD", "above": 0.50 },
    { "name": "dodo-swap-5000-pros", "kind": "call", "label": "DODO swap paid with 5000+ PROS",
      "to": "0xa5ca5fbe34e444f366b373170541ec6902b0f75c", "minValue": 5000 }
  ]
}
```

| kind | fields |
|---|---|
| `transfer` | `token` (USDC, WPROS or an address), `min` in whole tokens, optional `from`, `to` |
| `price` | `feed` (PROS/USD or a feed address), one of `above` / `below`, optional `rearm` (default 0.005) |
| `call` | `to`, optional `selector` or `function` (e.g. `withdraw(uint256 wad)`), optional `minValue` in PROS, `label` |

The file is checked when siren starts: a token has to answer `symbol()` and `decimals()` on mainnet, a feed has to
answer `decimals()`, names can't repeat, a price rule needs exactly one side. A typo stops siren with a reason
instead of watching nothing.

## Where the data comes from

| rule | source |
|---|---|
| transfer | `eth_getLogs` for `Transfer` on the token, in chunks of 1000 blocks (the RPC's limit) |
| price | `latestRoundData()` on the feed. PROS/USD is `0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466`, 18 decimals |
| call | the explorer API's transaction list for that contract, then every hit is read again with `eth_getTransaction`: `to`, selector and PROS value in the alert are the RPC's, not the explorer's |

WPROS transfers also get a "worth now" line at the current PROS/USD price. A transfer from the zero address is
titled "minted", one to it "burned".

## No repeats

- Every event has an id: `transfer:<tx>:<logIndex>`, `call:<tx>`, `price:<rule>:<feed update time>`. An id that
  was queued once is never queued again. The ids live in `state.json` with the last block read.
- A price rule fires when the price crosses its line, then goes quiet. It arms again only after the price has
  come back past the line by `rearm` (0.5% by default), so a price sitting on the line doesn't ping every round.
- The call watch looks 300 blocks back every round, because the explorer can be a little behind the RPC. The ids
  make that overlap harmless.
- An alert stays in the outbox until every channel took it. A channel that already has it isn't asked again, so a
  Discord error never means a second Telegram message.
- A Discord webhook takes about 5 messages in 2 seconds. When it answers 429, siren waits the `retry_after` it
  names and tries again (up to 4 times), so a `--since` replay of a busy hour arrives whole instead of in pieces.

## Secrets

The bot token and the webhook URL only come from siren's `.env` (or the environment): `SIREN_TELEGRAM_BOT_TOKEN`,
`SIREN_TELEGRAM_CHAT_ID`, `SIREN_DISCORD_WEBHOOK`. Not from the command line, so they don't end up in shell
history. Every error message is passed through a redactor that replaces them with `<hidden>` before printing.
siren needs no wallet and no private key: it only reads.

## Live run

Recorded on 2026-11-14 with a Claude Code agent that installed the skill from this repo, delivering to a real Discord
channel through the user's own webhook, saved in siren's `.env`. The agent never opened that file.

1. `siren test`: `✓ discord`, and the test message showed up in the channel.
2. A dry run first, `--since 100000 --once --console-only` in a scratch folder: a day of blocks, one hit.
3. The real run, `--since 100600` (wider by the minutes the dry run took) with the example rules, read blocks
   22957587 to 23058430 in 10,000-block rounds: `1 new alert, 1 delivered`. As siren printed it:

```
Large USDC transfer: 101,196.4227 USDC (from 0x6c4AD865b836f49e4D54ba3F2a21F0a082a46766, to 0x415306DD1a7C5EeD3F4cE6C12E32F9df37a7e584, rule 2500+ USDC) https://www.pharosscan.xyz/tx/0xe51d9ccb1ff866701fcdd71c75d291ec1697c818296081842a777baac8f76a53
```

   In Discord it arrived as one embed: title "Large USDC transfer" linking to the tx, the amount, from and to in
   full, rule `2500+ USDC`, block 23029505.
4. The same command again right after: siren carried on from block 23058431, read 39 new blocks, `0 new alerts`;
   `siren status` still showed 1 alerted and 0 waiting. Nothing new reached the channel.

## Layout

`src/pharos.ts` addresses and links · `src/rules.ts` the rules file · `src/watch.ts` one round of reading the
chain · `src/state.ts` what siren remembers · `src/outbox.ts` sending with retries · `src/deliver.ts` Telegram,
Discord, the `.env` · `src/alert.ts` how an alert reads in each place · `src/cli.ts` · `skill/siren/` SKILL.md
plus one bundled script.
