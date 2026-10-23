# 05 · Threshold Guardian (SkillEngine · Medium)

**trenchscope** is a periscope for the trenches. It's an agent skill for Prosper (pros-per.xyz) bonding-curve
tokens on Pharos mainnet. Before you ape into a token it checks the token on chain against your own limits and
says **APE** or **NOPE**. While you hold, it checks your bag and says **EXIT** or **HOLD**. Every run prints the
full decision trace: each check, its value, your limit, pass/fail, where the number came from, and the verdict.

I built it for how I actually trade these curves. The usual traps are a wallet sitting on 9% of the supply, a
"busy" token with three real holders, or buying when the curve is already half way to graduation. All of that
is readable on chain in a few seconds, so there's no reason to find out after the buy.

## The rules

**Buy: APE only if all of these pass**

| Check | Your setting | Read from |
|---|---|---|
| FDV | `max_fdv_usd` | market `quoteBuy` x 1B supply x Chainlink PROS/USD on Pharos |
| real holders | `min_holders`, bags worth at least `holder_min_pros` | Pharos explorer holder list, Prosper's own wallets left out |
| top holder | `max_holder_share_pct` | the same list: the biggest bag outside Prosper, contracts included |
| time left | `min_time_left_hours` | market `endsAt()` vs the latest block |
| progress | `max_progress_pct` | WPROS in the curve vs its 20,000 PROS graduation target |
| price impact (advice) | `advise_max_price_impact_pct` | `quoteBuy` on your size |

**Sell: EXIT as soon as any of these fires**

| Rule | Your setting | Read from |
|---|---|---|
| take profit / stop loss | `take_profit_pct`, `stop_loss_pct` | `quoteSell` on your bag vs what you paid |
| liquidity drain | `max_reserve_drop_pct` | PROS in the curve now vs when you bought |
| holder exodus | `max_holder_drop` | real holders now vs when you bought |
| whale | `max_whale_share_pct` | biggest bag outside Prosper and you |
| slippage (advice) | `advise_max_slippage_pct` | `quoteSell` on the whole bag vs spot |

**Advice** never blocks. When it flags, the agent has to ask you and get a yes before it trades.

Nothing is hard-coded: there are no default limits. On the first run the agent asks you for every value (it
offers suggestions) and saves them. You can change any of them later by just asking ("raise max FDV to 20k").

A few things I had to figure out on chain, because the Prosper contracts aren't verified:

- **Prosper's own wallets aren't holders.** Each new token is minted to the Prosper factory, which right away
  sends 73% to the market, 20% to the migration escrow and 7% to a Prosper contract (the same two contracts
  on every token I checked). trenchscope reads that split from the token's Transfer logs in its creation block, one
  request, and leaves those wallets out. Anyone else with a big bag counts, contracts too.
- **The creation transaction is sent by a Prosper relayer**, the same address for every token, so it says
  nothing about who launched the token. I don't use it as "the dev".
- **No history scan.** Reading every trade of a token takes minutes on the public RPC (1,000 blocks per log
  request). trenchscope only does `eth_call`s plus one explorer request for holders, so a buy check takes about
  7 seconds. Sell rules compare with a snapshot saved when you bought, so they don't need history either.
- **Missing data never leads to a trade.** If the explorer or the price feed can't be read, that buy check
  fails (NOPE) and that sell rule stays quiet (HOLD). The trace says what couldn't be read.
- **The PROS/USD feed:** the docs say to read `latestReportTimestamp` on the proxy, but on mainnet that call
  reverts. `latestRoundData()` works, so I use its `updatedAt` and treat the price as stale after 2 hours
  (the feed's heartbeat is 1 hour).

## Wallet and key

Both are optional.

- **Public address** (`wallet=0x...`): needed for sell checks. trenchscope reads your bag, and finds what you
  paid from your own Prosper trades if you bought by hand.
- **Key**: trenchscope has an execution module that sends the buy or sell through the Prosper router when a
  `PRIVATE_KEY=0x...` (or `MNEMONIC="..."`) is in the `.env` file in its data folder (`setup` prints where it
  is). You put it there yourself, never into the chat. Without a key it only advises: the agent tells you the
  verdict and you trade on Prosper yourself. With a key, every trade still needs your yes in the chat.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). No npm install: the skill is one bundled file.

**1. Install the skill** into your project:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/05-trenchscope/skill/trenchscope -a claude-code
```

It lands in `.claude/skills/trenchscope`. From a clone of this repo you can also install the local folder:

```bash
npx skills add ./05-trenchscope/skill/trenchscope -a claude-code
```

**2. Start your agent in that project and ask it something,** for example:

```text
thinking about aping 1 PROS into 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F, worth it?
```

On the first run it asks for your limits, saves them, then runs the check.

**3. Or run the same file without an agent:**

```bash
node .claude/skills/trenchscope/scripts/trenchscope.mjs setup
```

```bash
node .claude/skills/trenchscope/scripts/trenchscope.mjs config set max_fdv_usd=10k min_holders=4 holder_min_pros=1 max_holder_share_pct=5 min_time_left_hours=2d max_progress_pct=50 advise_max_price_impact_pct=3 take_profit_pct=50 stop_loss_pct=25 max_reserve_drop_pct=30 max_holder_drop=2 max_whale_share_pct=5 advise_max_slippage_pct=5 max_buy_pros=5 tx_slippage_pct=2
```

```bash
node .claude/skills/trenchscope/scripts/trenchscope.mjs buy 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F 1
```

Settings, positions and the run log live in `%APPDATA%\trenchscope` on Windows and `~/.config/trenchscope`
elsewhere. Set `TRENCHSCOPE_HOME` to use another folder.

## Commands

| Command | What it does |
|---|---|
| `setup` | every setting with what it means and a suggested value, plus wallet and key status |
| `config`, `config set k=v ...` | show or change settings (`10k`, `5%`, `48h`, `2d`, `off`) |
| `buy <market or token> <PROS>` | buy check for that size: APE or NOPE |
| `sell <market or token>` | sell check for your bag: EXIT or HOLD |
| `track <market or token> [--cost <PROS>]` | start watching a bag you bought by hand |
| `positions`, `log [--last N]` | bags it knows, the last runs |

`--execute` trades when the verdict says so (needs a key), `--approve` confirms flagged advice, `--json` gives
machine-readable output. Every run is also appended to `runs.jsonl` in the data folder. Exit codes: 0 done
(any verdict), 1 error, 2 needs setup or bad input, 3 needs your approval.

## Examples

Real runs on mainnet, in [`examples/`](examples):

- [`01-buy-ape-pmusk.txt`](examples/01-buy-ape-pmusk.txt): pMusk passes all 5 checks.
- [`02-buy-nope-penguin.txt`](examples/02-buy-nope-penguin.txt): Penguin fails on 3 real holders and one
  outside wallet holding 9.16% of the supply.
- [`03-buy-nope-after-config-change.txt`](examples/03-buy-nope-after-config-change.txt): the same pMusk check
  after lowering `max_fdv_usd` to $4k: now NOPE.
- [`04-sell-hold-penguin-whale.txt`](examples/04-sell-hold-penguin-whale.txt): sell check for the biggest
  Penguin bag (a public holder, about 755 PROS). It found the wallet's entry cost from its 4 Prosper buys: no
  rule fires, HOLD. The slippage advice already flags that dumping the whole bag would cost 10%.
- [`05-sell-exit-after-stop-loss-change.txt`](examples/05-sell-exit-after-stop-loss-change.txt): the same bag
  after tightening `stop_loss_pct` to 1%: EXIT, and because of the slippage advice the agent has to ask first.

## How it's built

- [`src/checks.ts`](src/checks.ts): the decision logic, pure functions over a market snapshot and your settings.
- [`src/chain.ts`](src/chain.ts): reads the market (`eth_call`s to `rpc.pharos.xyz`), the holder list and
  Prosper's creation split.
- [`src/prosper.ts`](src/prosper.ts): addresses and ABIs. The Prosper contracts aren't verified; the function
  names come from the Prosper web app and were checked with real calls.
- [`src/cli.ts`](src/cli.ts), [`src/trade.ts`](src/trade.ts): commands, and the buy/sell through the Prosper
  router (`buyInnerNative`, `sellInner`).
- [`skill/trenchscope`](skill/trenchscope): `SKILL.md` with the agent's instructions, and the bundled
  `scripts/trenchscope.mjs` built from `src` with `npm run build`.

## Tests

```bash
npm test -w 05-trenchscope
```

Tests run the decision logic on real snapshots of two markets recorded from mainnet (`test/fixtures`): APE and
NOPE, a threshold change flipping the verdict, advice asking instead of blocking, failing closed when the
explorer or the price feed is down, every sell rule, the entry cost of a bag bought by hand, settings typed
like people type them, and the key coming only from `.env`. CI runs them on every push.
