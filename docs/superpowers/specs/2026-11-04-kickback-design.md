# kickback: a bonus cashback draw that nobody can rig, decided by a block that does not exist yet

Task 17 of the Pharos Agent Arena (skill-chain-mcp-flow). Folder: `17-kickback`. Status: draft, 2026-11-04.

## Why

The task: one working agent flow where a SkillEngine skill and Chain MCP work together, the skill deciding and
Chain MCP supplying live chain data (or the reverse), composed rather than used side by side. Requirements:

1. The skill's output depends on live data fetched via Chain MCP in the same flow.
2. The flow runs end to end from a single user request.
3. A diagram or short write-up of the flow: what calls what, and in what order.
4. A demo run showing real data moving through both tools.

What the leaders did (`../../../../docs/arena-competitors.md`, section 17, READMEs read 2026-11-04): all three
built a deterministic "is this transfer OK / done" verdict from their own skill (shoupeorg: can this wallet afford
X PROS; edycutjong: can I treat this tx as paid; moltaphet: send 1 USDC, READY or STOP). Our own tasks 09 and 16
are the same genre. Reviewers gave us innovation 2 and originality 2 on every task since 03.

kickback is a different kind of decision: a fair draw. The user says one sentence ("send a bonus cashback to 3
random buyers among the last 30 buyers of Prosper tokens"). The skill pulls the real buyers from the chain,
writes the list and the rule on chain first, waits for a future block, uses that block's hash to pick the
winners, pays them, and checks the payouts. The answer cannot exist before block N is mined, so the dependence
on live chain data is total, and anyone can re-derive the winners from one transaction hash.

User decisions (2026-11-04): direction "fair draw" over "smart slippage swap"; call it bonus cashback; pay right
away from the one request, guarded by a hard cap (no "yes" round-trip); the skill takes parameters from the
request with defaults; participants are recent buyers of Prosper tokens (curve buyers were the first wish, see
the facts below for why the V2 pairs are used).

## Verified facts this design rests on (Pharos mainnet, 2026-11-04)

- Chain MCP `https://mcp.pharos.xyz/mcp` lists 14 tools: get_chain_info, get_block_number, get_balance,
  get_transaction_count, get_gas_price, get_block, get_transaction, get_transaction_receipt, get_code,
  get_storage_at, eth_call, estimate_gas, get_logs, send_raw_transaction. `get_block` returns `hash`.
  `eth_call` takes `{transaction: {...}, block?}`; `get_logs` takes `address` as a string or an array.
  Limit: 120 requests/min per IP, get_logs at most 1000 blocks (memory, task 01 recon).
- Prosper curve buys are almost gone: event `Bought(address indexed router, address indexed trader, ...)`
  (topic `0x2683a506cc521e11c368ce9c068585a91786a3cb7ab4089b602eb2835acb1639`, checked against our own task-16 buy
  in block 22113010) appears 9 times in the last 100,000 blocks, 2 of them ours.
- Prosper's graduated tokens trade on Prosper's V2 router `0x14f06fe99a1264825c99fb1c8e05a90036e89d0a` (listed as
  `uniV2Router` in the Prosper deployment API, task 06 memory). Its factory `0x9343D6F1a7058a9ffD43028666dB23CFcE3E0D1e`
  (from `factory()`) has `allPairsLength() = 10`, every pair is WPROS `0x52C48d4213107b20bC583832b0d951FB9CA8F0B0`
  against a p-token (pTACO, pCARP, pROG, pAIL, pCARR, pTier, pTART, pIE, pOTUS, pDOG).
- The pairs emit the standard UniswapV2 `Swap(address indexed sender, uint amount0In, uint amount1In, uint
  amount0Out, uint amount1Out, address indexed to)` (topic `0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822`).
  A buy = WPROS in. `to` (topic 2) is the wallet that got the p-tokens.
- Measured from head 22132490: 30 distinct buyers within 24,416 blocks (about 7 h), 25 get_logs windows over the
  10 pairs (one call per window with the address array), 114 swaps, 46 buys; all 30 buyers have no code
  (`eth_getCode` = `0x`). 77 calls in total including setup, so under a minute at the MCP pace.
- Other sources were measured and dropped: USDC senders (733 of 884 distinct senders are 101-byte deposit-style
  proxies; 100 plain wallets need 45k blocks, ~930 calls) and native PROS senders (no logs, block scan only;
  30 senders need 7,264 `get_block` calls, about an hour).
- Pharos `eth_call` without `to` (initcode trick) returns `0x`, so code checks are one `get_code` per address.
- Gas, from the test wallet: a 0-PROS self transaction with 608 bytes of data estimates 40,252 gas; a USDC
  `transfer` of 10 raw units estimates 79,757 gas. Gas price 10 gwei. So commit + 3 payouts is about 0.0028 PROS.
- Test wallet `0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb`: 0.5 USDC (500000 raw, the user topped it up today) and
  0.03466 PROS.
- `cast send` (Foundry 1.5.1) has no environment variable for `--private-key` (only `--keystore` /
  `ETH_KEYSTORE`), checked in `cast send --help`.

## The flow (one request, in this order)

```
user: "send a bonus cashback to 3 random buyers among the last 30 buyers of Prosper tokens"
  |
agent loads the kickback skill (SKILL.md), maps the sentence to parameters, runs ONE command:
  kickback draw --pool 30 --winners 3 --amount 0.00001 --token USDC
  |
 1  Chain MCP  get_block_number                       -> snapshot block S (the pool is "as of S")
 2  Chain MCP  eth_call factory.allPairsLength/allPairs, pair.token0 -> the 10 pairs, which side is WPROS
 3  Chain MCP  get_logs Swap over the pairs, 1000-block windows back from S -> buys, newest first
 4  Chain MCP  get_code for each new buyer             -> keep wallets without code, drop the rest
    skill: dedupe, drop our own wallet, stop at 30 people (or report fewer if the look-back cap is hit)
 5  Chain MCP  get_balance + eth_call USDC.balanceOf    -> can we pay winners x amount and the gas? if not, stop
                                                          here, nothing is sent
 6  skill      build the commit: version, params, S, pool (30 addresses), target offset D
    Chain MCP  get_transaction_count, get_gas_price, estimate_gas -> skill signs a 0-PROS self transaction whose
               data is the commit
    Chain MCP  send_raw_transaction, then get_transaction_receipt until mined in block C
    target block N = C + D (D default 5)
 7  Chain MCP  get_block_number until head >= N, then get_block N -> hash H
 8  skill      seed = keccak256(H, commitTxHash); pick winner i = keccak256(seed, i) mod remaining, without
               replacement, i = 0..K-1
 9  per winner: Chain MCP estimate_gas -> skill signs USDC.transfer(winner, amount) -> send_raw_transaction
               -> get_transaction_receipt, and the receipt must carry the Transfer(from us, to winner, amount) log
10  report: snapshot block, pool, commit tx, N and H, the seed, the winners in pick order, each payout tx and its
    status, total spent. Same content as JSON in the data folder.
```

Who talks to Chain MCP (my call): the bundled `kickback.mjs` is itself the Chain MCP client (streamable HTTP
session to `https://mcp.pharos.xyz/mcp`, one session per run, paced at about 115 calls/min), like task 13. So the
one `draw` command really is the whole flow. To keep the composition visible, `draw` prints every Chain MCP call
live as it happens (step, tool name, short args, milliseconds) and the JSON keeps the full ordered list, which is
also what ARCHITECTURE.md quotes. The agent's own MCP connection is not required by the flow.

The skill decides who is a participant, when the draw happens and who wins; Chain MCP supplies every input
(logs, codes, balances, the block hash) and carries every transaction. No step uses another RPC.

Why the commit goes on chain before the hash exists: if the list and the rule were only shown after block N, the
runner could pick a block, look at its hash, then shape the list. With the full pool inside the commit
transaction, the list is fixed at block C, and the hash of block C+D was unknown at that moment. The README says
plainly what this does not cover: the block producer of block N could in theory influence its hash.

## Commit format

Data of the self transaction: the ASCII prefix `kickback:1:` followed by an ABI-encoded tuple
`(uint64 snapshotBlock, uint16 targetOffset, uint16 winners, address token, uint256 amountRaw, address[] pool)`.
All of it on chain, so verification needs only the commit tx hash (30 addresses is about 1 KB of data, 100 is
about 3.3 KB; both cheap at 10 gwei). Exact byte layout is the builder's call as long as `verify` can decode it
from the transaction alone.

## Commands

- `kickback draw [--pool N] [--winners K] [--amount X] [--token USDC|PROS] [--delay D] [--dry]`: the flow above.
  `--dry` stops after step 5 and prints the pool and what would be committed and paid (nothing signed).
- `kickback verify <commitTxHash> [payoutTx...]`: reads the commit tx, decodes it, reads block C + D and its hash
  through Chain MCP, recomputes the winners, and prints them with MATCH or the first difference. Payout check (my
  call): for USDC it finds the payouts by `get_logs` on USDC Transfer with `from` = commit sender and `to` = each
  winner, from block N over a bounded window; PROS transfers leave no logs, so for PROS the payout tx hashes are
  passed on the command line (the draw report and the README list them) and each is checked with
  `get_transaction` + receipt. This is the "don't trust me, check it" command for a skeptic.

Failed payout (my call): a payout that fails is retried on `--resume`; if its simulation keeps reverting, that
winner is marked FAILED in the report and the run ends. No replacement winner is drawn (it would add a second
rule a skeptic has to trust). `verify` shows FAILED winners as such.
- `kickback setup`: prints the data folder, the wallet address (never the key), balances and the caps.

## Parameters, defaults and caps

| Param | Default | Allowed | Notes |
|---|---|---|---|
| pool | 30 | 2..100 | last N distinct buyers before the snapshot |
| winners | 3 | 1..10, and < pool | |
| amount | 0.00001 | > 0 | per winner |
| token | USDC | USDC, PROS | PROS payouts are plain value transfers |
| delay | 5 blocks | 1..50 | N = commit block + delay |
| look-back | 50,000 blocks | config only | if fewer than `pool` buyers are found, say so and draw from those (at least 2) |

Hard caps live in the config file in the data folder, never in the request: `max_total_usdc` (default 0.0001),
`max_total_pros` (default 0.001). `winners x amount` above the cap stops the run before the commit, with the cap
named. The agent cannot raise a cap from chat; the SKILL.md says the user edits the file.

## Keys and sending

The key sits in `KICKBACK_HOME/.env` (`PRIVATE_KEY=`), loaded by the tool; it is never printed, logged or passed
on a command line. Signing is local (viem `signTransaction`), broadcasting goes through Chain MCP
`send_raw_transaction`. My call, flagged for the user: earlier in chat I said payouts would go through the official
SkillEngine's `cast send`; I changed it because `cast send` only takes a raw key as a command-line argument (visible
in the process list) and because sending through Chain MCP keeps every chain read and write in the composed pair.
The official `pharos-skill-engine` is still the recommended companion install in the README for manual checks.

Data folder: `KICKBACK_HOME`, else `%APPDATA%\kickback` / `~/.config/kickback`. Live runs use the test wallet with
`KICKBACK_HOME` pointed at `trenchsaga-home` (key already there). Claude never runs a sending command; the user
launches every live draw. During the build Claude uses `--dry`, `verify` (read only) and recorded tapes only. In
the demo the agent inside the recording runs `draw` itself (that recording is started by the user, so it counts
as the user's launch, same as tasks 06 and 16). The SKILL.md tells the agent to run `draw` directly when the user
asks for a payout. The README proof comes from that recorded run.

Each draw writes `draws/<commitTx>.json` and appends one line to `draws.jsonl`. A crash after the commit (block N
not reached, a payout failed) leaves the JSON with the state so far; `kickback draw --resume <commitTx>` continues
from the first missing step and never re-pays a winner whose payout is already on chain.

## The skill

`skill/kickback/SKILL.md` in the SkillEngine format (frontmatter `name`, `description`, `version`,
`requires.anyBins: [node]`), plus `scripts/kickback.mjs` (one esbuild bundle, no install), like tasks 05 and 16.
The SKILL.md tells the agent how to map a request to flags ("five lucky ones" -> `--winners 5`, "from the last 50"
-> `--pool 50`, "in PROS" -> `--token PROS`), to run `draw` once, and to explain the report in plain words
including how to verify. No fixed phrases for the agent to say.

## Write-up and diagram (requirement 3)

`17-kickback/ARCHITECTURE.md`: a Mermaid sequence diagram of the flow above (user, agent, kickback skill, Chain
MCP, Pharos) with the call order numbered, and a short text of who decides what. The README links it.

## Demo (video +50, the user launches the recording; Claude never signs)

Claude Code agent with the kickback skill installed and Chain MCP connected; the user plays a newbie in plain
English. Prompts (drafts, final wording at recording time):
1. install the skill from the repo;
2. the one request: "send a bonus cashback to 3 random people who bought Prosper tokens recently, 0.00001 USDC each";
3. a skeptic's turn: "how do I know you didn't pick your friends?" -> agent runs `verify` on the commit tx;
4. optional: a second draw with request params ("5 winners from the last 50, in PROS") to show the parameters.
Proof in the README (anchor): the commit tx, block N and its hash, the payout txs, the verify output.

## Tests

`node --test` on the pure parts: Swap decoding and buy detection for both token orders, pool building (dedupe,
self, contracts, cap on look-back), commit encode/decode round trip, the draw (fixed hash -> fixed winners, no
repeats, K = pool - 1 edge), caps and parameter validation, resume logic. Chain calls behind a small interface so
tests use recorded answers.

## Non-goals

- No randomness beacon or VRF: the block hash is the source, with its limit stated.
- No batch contract or Multicall payout (task 15 already did batching).
- No testnet, no deploy, no LLM inside the tool.
- No curve (`Bought`) buyers in v1: too few right now (see facts). Left as an easy extension behind `--source`.

## Anti-goals

- Hardcoded agent phrases in the tool or demo scripts.
- Claude sending funds or printing the key.
- A draw whose list or rule could be changed after block N is known.
- A requirements checklist in the README (the mapping goes into the arena notes field).

## Left to the builder

- Exact commit byte layout (must decode from the tx alone).
- How `verify` finds the payouts (bounded window after block N).
- MCP pacing (one session, about 115 calls/min) and retries.
- Waiting for block N: poll interval (blocks are about 1 s).
- Naming and file split inside `src/`, in the code voice of tasks 14-16.
