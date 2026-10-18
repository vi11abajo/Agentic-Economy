# 02 · Event/Log Monitor (Chain MCP · Easy)

A continuous monitor that watches **Prosper bonding curves** on Pharos Pacific Mainnet and reports **every buy and
sell** as it happens — for one token or many. Everything is read through **Pharos Chain MCP**
(`https://mcp.pharos.xyz/mcp`); no dApp API, no indexer.

[Prosper](https://app.pros-per.xyz) is a launchpad on Pharos: each vault gets a pToken that trades on its own
bonding curve (a `market` contract) until it graduates. Every trade on a curve emits one event from that market:

| Event (matched against on-chain logs by topic hash) | Fields |
|---|---|
| `Bought(address indexed router, address indexed trader, uint256 grossIn, uint256 netIn, uint256 pTokenOut, uint256 fee)` | PROS paid (gross / after fee), pTokens received, fee |
| `Sold(address indexed router, address indexed trader, uint256 pTokenIn, uint256 grossOut, uint256 netOut, uint256 fee, bool toNative)` | pTokens sold, PROS received (gross / after fee), fee |

The signatures were recovered from the topic hashes of real logs (no verified source available); the field names
are inferred from the values (`gross − fee = net` holds on every trade seen).

## How it works

1. **Config** — [`markets.json`](markets.json) lists the curves to watch (any number):
   ```json
   { "intervalSec": 3, "confirmations": 3,
     "markets": [ { "name": "SPACE X Strategy (sxss)", "market": "0x5c3E…8B7F", "minPros": 0 } ] }
   ```
   For each market the monitor reads its `pToken()` and the token's `symbol()/name()/decimals()` with `eth_call`.
2. **One log query for all curves** — every poll calls MCP `get_logs` with `address: [all markets]` and
   `topics: [[Bought, Sold]]` over the new blocks (≤ 1000 per call, 3 blocks behind the head).
3. **Only new events, no duplicates** — events are keyed `txHash:logIndex`; the next block and recent keys are
   saved in `.monitor-state.json`, so a restart resumes exactly where it stopped.
4. **Readable output** — side, token, trader, PROS paid/received, pTokens, curve price (PROS per pToken), fee,
   block, time, tx hash; every trade is also appended to `trades.jsonl`.

## Run

From the repository root: `npm install && npm run build`. Then in this folder:

```bash
npm start                                    # watch every curve in markets.json, forever (Ctrl+C to stop)
npm start -- --from-block 20372512           # replay history from a block, then keep watching live
npm run add -- 0xMARKET --name "My token" --min 10   # add a curve (validated via MCP); only trades ≥ 10 PROS
npm run discover -- --blocks 60000           # list curves created recently (ProsperFactory events via MCP)
```

To follow a token you see in the app (`…?vault=sxss-46f0d8`), run `discover` — the `vault …46f0d8` column is the
same suffix — and `add` its market. Read-only, no keys.

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

pMusk history (its whole curve so far):

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

Cross-check: the net amounts 9.9 + 4.95 + 49.5 + 4.95 = **69.3 PROS** — exactly the "Graduation progress 69.3 /
20,000 PROS" the Prosper app shows for this curve; the price rises with each buy, as a bonding curve should.

## Live demo (hosted)

The same Chain MCP log monitoring runs 24/7 as a small service
([`services/prosper-monitor`](../services/prosper-monitor)) for every Prosper token still on its bonding curve:

- Live feed (decoded trades with block, trader, amounts, price, tx): https://mcp.pharosfdv.xyz/prosper-monitor
- JSON: https://mcp.pharosfdv.xyz/prosper-monitor/trades.json?limit=50
- Telegram alerts per token (whitelist), and an MCP endpoint for AI agents:
  `claude mcp add --transport http prosper-monitor https://mcp.pharosfdv.xyz/prosper-monitor/mcp`

## Tests

`npm test` runs on the real `get_logs` result of the two trades caught in the video
([`test/fixtures/pmusk-demo-logs.json`](test/fixtures/pmusk-demo-logs.json)): event signatures, decoding of the
buy and the sell, chain ordering, no duplicates across polls, re-org (`removed`) logs, `minPros`, and the
1,000-block window ([`src/curve.test.ts`](src/curve.test.ts)).
