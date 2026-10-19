# 01 · Read Contract State (Chain MCP · Easy)

Reads the live state of a Pharos contract **through Pharos Chain MCP** (`https://mcp.pharos.xyz/mcp`) and
explains it in plain words. I did it two ways:

1. **Agent** ([`agent/`](agent)): a Claude Code agent with Pharos Chain MCP, asked normal English questions.
   Every answer comes from MCP tool calls you can see in the transcript.
2. **Script** (`src/`): a TypeScript MCP client that reads the same values, formats them and double-checks
   what the agent said.

## Contract

**USDC on Pharos Pacific Mainnet**, `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`
(listed as "USDC (Circle Deployed)" in the [Pharos Token Registry](https://docs.pharos.xyz/getting-started/token-registry)).

I picked it because it's more than a plain ERC-20. It's Circle's upgradeable `FiatTokenProxy` with several admin
roles, so the report can show who actually controls the token, not just the supply.

Other contracts work too (`--contract 0x...`). Functions a contract doesn't have are just skipped.

## 1 · Agent: Claude Code + Pharos Chain MCP

One conversation with a Claude Code agent ([`agent/prompts/`](agent/prompts)). In the first message it installs
Pharos Chain MCP by itself, after that it can only use the Pharos MCP tools.

| # | I ask | What the agent did | Answer |
|---|---|---|---|
| 1 | "Hi! Please install the Pharos MCP server for yourself: https://mcp.pharos.xyz/mcp" | ran `claude mcp add --transport http -s project pharos https://mcp.pharos.xyz/mcp` → [`agent/.mcp.json`](agent/.mcp.json) | installed, tools load on the next turn |
| 2 | "Hey, are you hooked up to the Pharos chain? Which network are you on, and what's the latest block?" | Pharos MCP `get_chain_info` | chain 1672, latest block 20,414,351 |
| 3 | "There's a token contract at 0xC879…1815 on Pharos mainnet. What's it called? Please read it on-chain at block 20,399,245, …" | `eth_call` name(), symbol() | **USDC** |
| 4 | "How many of these tokens are out there? Give me the total supply in a format a normal person can read." | `eth_call` totalSupply(), decimals() | **41,609,740.342546 USDC** |
| 5 | "Who owns this contract?" | `eth_call` owner() | **0x9f8e…4d92** |
| 6 | "How much of it does 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819 hold?" | `eth_call` balanceOf() | **1,311,134 USDC** (about 3.15% of supply) |
| 7 | "Sum it up for me in plain English: what is this token, and what do those numbers mean for someone who isn't a developer?" | no new calls, uses the values above | plain-English summary |

**Run it** (needs the `claude` CLI, signed in):

```bash
bash agent/run-agent.sh   # runs the conversation and saves the transcripts
bash agent/demo.sh        # same conversation typed live in the terminal (that's what the video shows)
```

The first turn may only run `claude mcp add`. Every turn after that runs with `--strict-mcp-config` and only the
`pharos` MCP server allowed (no shell, files or web), so every fact has to come from a Pharos Chain MCP call.

- [`agent/TRANSCRIPT.md`](agent/TRANSCRIPT.md): prompt, tool call with arguments, raw result, answer
- [`agent/transcripts/`](agent/transcripts): the same as JSON Lines (other MCP servers and local paths removed)

**Checked against the script.** All four values match the script's trace
([`sample-trace.jsonl`](sample-trace.jsonl)). The script also reads things one question doesn't cover: all the
admin roles and the ZeppelinOS proxy slots of Circle's `FiatTokenProxy` (proxy admin `0x46f9…3F1b`,
implementation `0xC35B…eAe8`).

## 2 · Script

### What it reads (all at one block)

| Value | MCP tool |
|---|---|
| Chain id, latest block | `get_chain_info` |
| Block hash and time | `get_block` |
| Contract bytecode (to make sure there is a contract) | `get_code` |
| `name`, `symbol`, `decimals`, `totalSupply`, `currency`, `version`, `paused` | `eth_call` |
| Roles: `owner`, `masterMinter`, `pauser`, `blacklister`, `rescuer` | `eth_call` |
| Proxy admin and implementation | `get_storage_at` (ZeppelinOS slots, EIP-1967 as fallback) |
| Balances (`--holder`, optional) | `eth_call` → `balanceOf` |

Formatting: decimals applied, digits grouped, every address labelled with its role and what that role can do,
the zero address shown as "not assigned", block number and UTC time, plus an explorer link.

The block is pinned 3 blocks behind the head, so all values describe the same moment and the block is already
on every RPC node behind the MCP server.

### Run

From the repo root (one install for all tasks):

```bash
npm install
npm run build
```

Then in this folder:

```bash
npm start                                   # USDC, latest block
npm start -- --block 20399245               # a specific block
npm start -- --holder 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819
npm start -- --contract 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0   # WPROS
npm start -- --json                          # JSON output
npm start -- --trace trace.jsonl             # log every MCP call and its raw response
```

The sample files come from
`npm start -- --block 20399245 --holder 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819 --trace sample-trace.jsonl`.

### Trace

[`sample-trace.jsonl`](sample-trace.jsonl) has one line per Pharos Chain MCP call (18 calls): tool name,
arguments (for `eth_call` the target, calldata and block), the raw response, and for `eth_call` the decoded
function and value. Nothing is read outside MCP, for example:

```text
eth_call name()            -> "USDC"
eth_call totalSupply()     -> 41609740342546  (raw, 6 decimals -> 41,609,740.342546)
eth_call owner()           -> 0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92
eth_call balanceOf(0x4083…9819) -> 1311134000000 (-> 1,311,134 USDC)
```

No keys or wallet needed, it's all read-only. The client keeps under the server's limit of 120 requests per
minute per IP (`packages/pharos-mcp`).

### Sample output

[`sample-output.txt`](sample-output.txt) (block 20,399,245, one `--holder`):

```text
USDC on Pharos Pacific Mainnet (chain 1672)
Contract:  0xC879C018dB60520F4355C26eD1a6D572cdAC1815  (https://www.pharosscan.xyz/address/0xC879C018dB60520F4355C26eD1a6D572cdAC1815)
Read at:   block 20,399,245  (2026-10-16 14:14:48 UTC)
Source:    Pharos Chain MCP https://mcp.pharos.xyz/mcp

Token
  Name / symbol    USDC / USDC
  Decimals         6
  Total supply     41,609,740.342546 USDC  (raw 41609740342546)
  Pegged to        USD
  Code version     2
  Status           Active, transfers work

Who controls it
  0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92  Owner: can reassign every role below
  0x908EA62d2529F31347d71992954E540A8d169603  Master Minter: decides who may mint new tokens
  0x828409Db274caD94AC10db6D54aeCa1Dbe00e237  Pauser: can freeze all transfers
  0xbA8Cd4958d4105Aaa23b00c645573F53fCd59486  Blacklister: can block individual addresses
  (not assigned)                              Rescuer: can recover tokens sent to the contract by mistake
  0x46f958BdEFfD33495E058873cDd114c79Ec13F1b  Proxy admin: can upgrade the contract code
  0xC35BEcB283fEC66626220467265F6d3B3f8cEae8  Implementation: the contract code currently in use

Balances
  0x40836f8F1bD7e13d99a4cc9DE5C0B80A83109819  1,311,134 USDC

In plain words
  At block 20,399,245 there were 41,609,740.342546 USDC in circulation on Pharos. Each token is meant to be worth 1 USD. Transfers are working normally.
  The address you interact with is an upgradeable proxy: its rules live in a separate implementation contract,
  and the proxy admin can swap that code. Special roles (owner, minter, pauser, blacklister) hold admin powers.

(18 Pharos MCP tool calls, contract bytecode 1798 bytes)
```

## Tests

`npm test` replays the real MCP session from [`sample-trace.jsonl`](sample-trace.jsonl) through `readContract`
(no network) and checks every value against the sample output. It also covers the error cases: wrong chain,
no contract code, a reverted call, and picking the block ([`src/contract.test.ts`](src/contract.test.ts)).
