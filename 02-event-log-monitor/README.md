# 02 · Event/Log Monitor (Chain MCP · Easy)

A monitor that keeps running and prints **every buy and sell on Prosper bonding curves** (Pharos Pacific
Mainnet) as it happens, for one token or many. All data comes from **Pharos Chain MCP**
(`https://mcp.pharos.xyz/mcp`). No dApp API, no indexer.

[Prosper](https://app.pros-per.xyz) is a launchpad on Pharos. Each vault gets a pToken that trades on its own
bonding curve (a `market` contract) until it graduates. Every trade on a curve emits one event from that market:

| Event (matched to on-chain logs by topic hash) | Fields |
|---|---|
| `Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)` | PROS paid (gross / after fee), pTokens received, fee |
| `Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)` | pTokens sold, PROS received (gross / after fee), fee |

There's no verified source for these contracts, so I recovered the signatures from the topic hashes of real logs.
The field names are my guess from the values (`gross - fee = net` holds on every trade I've seen).

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and git. No keys, no wallet. Check Node with:

```bash
node -v
```

**1. Get the code and build it.** One time for all tasks in this repo, about a minute:

```bash
git clone https://github.com/vi11abajo/Agentic-Economy.git
```

```bash
cd Agentic-Economy
```

```bash
npm ci
```

```bash
npm run build
```

**2. Replay the two trades from the video** (a pMusk buy and sell, about 10 seconds, then it stops):

```bash
npm start --workspace 02-event-log-monitor -- --config demo/markets-demo.json --from-block 20506720 --max-events 2
```

**3. Watch live.** Follows every curve in [`markets.json`](markets.json) and prints each new buy or sell as it
happens. Prosper trades come in bursts, so a quiet minute is normal. Stop with Ctrl+C, the next start picks up
where it stopped:

```bash
npm start --workspace 02-event-log-monitor
```

**4. Find a token you saw in the app** and add it (lists curves created in the last ~60,000 blocks):

```bash
npm run discover --workspace 02-event-log-monitor -- --blocks 60000
```

```bash
npm run add --workspace 02-event-log-monitor -- 0xMARKET --name "My token"
```

## How it works

1. **Config.** [`markets.json`](markets.json) lists the curves to watch, as many as you want:
   ```json
   { "intervalSec": 3, "confirmations": 3,
     "markets": [ { "name": "SPACE X Strategy (sxss)", "market": "0x5c3E…8B7F", "minPros": 0 } ] }
   ```
   For each market it reads `pToken()` and the token's `symbol()/name()/decimals()` with `eth_call`.
2. **One log query for all curves.** Each poll calls MCP `get_logs` with `address: [all markets]` and
   `topics: [[Bought, Sold]]` over the new blocks (up to 1000 per call, 3 blocks behind the head).
3. **Only new events, no duplicates.** Events are keyed by `txHash:logIndex`. The next block and recent keys are
   saved in `.monitor-state.json`, so after a restart it picks up exactly where it stopped.
4. **Readable output.** Side, token, trader, PROS paid or received, pTokens, curve price (PROS per pToken), fee,
   block, time and tx hash. Every trade is also appended to `trades.jsonl`.

## Run

After the Quick start setup, from inside `02-event-log-monitor`:

```bash
npm start                                    # watch every curve in markets.json until Ctrl+C
npm start -- --from-block 20372512           # replay from a block, then keep watching live
npm run add -- 0xMARKET --name "My token" --min 10   # add a curve (checked via MCP), only trades of 10+ PROS
npm run discover -- --blocks 60000           # list recently created curves (ProsperFactory events via MCP)
```

To follow a token you see in the app (`…?vault=sxss-46f0d8`), run `discover`. The `vault …46f0d8` column is the
same suffix, then `add` its market. Read-only, no keys.

## Sample output

Live and replayed trades on four curves (pMusk, pPeng, pFlye, psmil):

```text
Watching 4 Prosper curve(s) for buys and sells
  pMusk      market 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F · pToken 0xE318ac4113324841265d270Dc2393f1Bf742A7f8
  pPeng      market 0xe534Dadb1E32A9DF075ffcAE0D636fF472A040db · pToken 0xc927DEf5467B85876310f1ef80d1C276b8f8a3AA
  ...
#1 BUY  pPeng  block 20,371,198 · 06:53:59 UTC
    0x5f1A…2784  paid 0.4 PROS → got 41,527 pPeng
#2 SELL pPeng  block 20,371,198 · 06:53:59 UTC
    0x5f1A…2784  sold 41,527 pPeng → got 0.39204 PROS
```

pMusk history (the whole curve at that point):

```text
#1 BUY  pMusk  block 20,393,489 · 12:43:39 UTC
    0xcB9C…835B  paid 10 PROS → got 1,317,200 pMusk
    price 0.000007516 PROS/pMusk · fee 0.1 PROS · tx 0x1fa309528ec4810528e455d1d2027d0d49688b62a1d22bad1ae80460086dff5d
#2 BUY  pMusk  block 20,406,821 · 16:14:54 UTC
    0xd8fB…13c3  paid 5 PROS → got 657,306 pMusk
#3 BUY  pMusk  block 20,407,260 · 16:21:46 UTC
    0x34E0…9680  paid 50 PROS → got 6,526,044 pMusk
#4 BUY  pMusk  block 20,423,479 · 20:42:26 UTC
    0x4f6d…C793  paid 5 PROS → got 647,939 pMusk
```

Sanity check: the net amounts 9.9 + 4.95 + 49.5 + 4.95 = **69.3 PROS**, which is exactly the "Graduation
progress 69.3 / 20,000 PROS" the Prosper app showed for this curve. And the price goes up with each buy, like
a bonding curve should.

## Hosted version

The same monitoring runs 24/7 as a small service ([`services/prosper-monitor`](../services/prosper-monitor))
for every Prosper token that is still on its curve:

- Live feed (trades with block, trader, amounts, price, tx): https://mcp.pharosfdv.xyz/prosper-monitor
- JSON: https://mcp.pharosfdv.xyz/prosper-monitor/trades.json?limit=50
- Telegram alerts per token (whitelist) and an MCP endpoint for AI agents:
  `claude mcp add --transport http prosper-monitor https://mcp.pharosfdv.xyz/prosper-monitor/mcp`

## Tests

`npm test` uses the real `get_logs` result for the two trades caught in the video
([`test/fixtures/pmusk-demo-logs.json`](test/fixtures/pmusk-demo-logs.json)). It checks the event signatures,
decoding of the buy and the sell, chain order, no duplicates across polls, re-org (`removed`) logs, `minPros`
and the 1000-block window ([`src/curve.test.ts`](src/curve.test.ts)).
