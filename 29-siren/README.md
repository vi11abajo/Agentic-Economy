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

This is what `siren init` writes:

```json
{
  "pollSeconds": 10,
  "rules": [
    { "name": "usdc-400", "kind": "transfer", "token": "USDC", "min": 400 },
    { "name": "wpros-800", "kind": "transfer", "token": "WPROS", "min": 800 },
    { "name": "pros-below-45c", "kind": "price", "feed": "PROS/USD", "below": 0.45 },
    { "name": "pros-above-50c", "kind": "price", "feed": "PROS/USD", "above": 0.50 },
    { "name": "dodo-swap-50-pros", "kind": "call", "label": "DODO swap paid with 50+ PROS",
      "to": "0xa5ca5fbe34e444f366b373170541ec6902b0f75c", "minValue": 50 }
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

## Secrets

The bot token and the webhook URL only come from siren's `.env` (or the environment): `SIREN_TELEGRAM_BOT_TOKEN`,
`SIREN_TELEGRAM_CHAT_ID`, `SIREN_DISCORD_WEBHOOK`. Not from the command line, so they don't end up in shell
history. Every error message is passed through a redactor that replaces them with `<hidden>` before printing.
siren needs no wallet and no private key: it only reads.

## Live run

A first run with `--since 1500` on 2026-11-14, console only, read blocks 23043872 to 23045371 in 7.5 s and found
12 events with the example rules. Two of them, as siren printed them:

```
Large WPROS transfer: 1,364.0898 WPROS (from 0x08cd62babd8Dac7404504792Df30C12fC5384Df5, to 0xCb79097744d5266bFca287A43612D9613Be46300, worth now $647.76 at PROS/USD 0.4749, rule 800+ WPROS) https://www.pharosscan.xyz/tx/0x14f5c554d102fa35a2aecf78515de0aaedfa488a8bdbd73a12cfa47e4e9c23af
DODO swap paid with 50+ PROS: 189.2154 PROS sent with the call (caller 0x482e1427981f9ae4671ee6ae12048aae81b72959, function 0xff84aafa) https://www.pharosscan.xyz/tx/0x6b023a803a34b5114a26b72edeb34c72bce5d81abef22333b9fb9eb8f86bea2c
```

The very next round read blocks 23045372 to 23045380 and queued nothing: the 12 were already in `state.json`.

## Layout

`src/pharos.ts` addresses and links · `src/rules.ts` the rules file · `src/watch.ts` one round of reading the
chain · `src/state.ts` what siren remembers · `src/outbox.ts` sending with retries · `src/deliver.ts` Telegram,
Discord, the `.env` · `src/alert.ts` how an alert reads in each place · `src/cli.ts` · `skill/siren/` SKILL.md
plus one bundled script.
