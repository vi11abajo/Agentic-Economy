# 01 · Read Contract State (Chain MCP · Easy)

Reads live state of a deployed Pharos contract **through Pharos Chain MCP** (`https://mcp.pharos.xyz/mcp`)
and explains it in plain language for a non-developer — two ways:

1. **Agent** ([`agent/`](agent)) — a Claude Code agent with Pharos Chain MCP connected, asked plain-English
   questions; every answer is backed by MCP tool calls recorded in its transcript.
2. **Script** (`src/`) — a TypeScript MCP client that reads the same values deterministically, formats them and
   cross-checks the agent.

## Contract

**USDC on Pharos Pacific Mainnet** — `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`
(listed as "USDC (Circle Deployed)" in the [Pharos Token Registry](https://docs.pharos.xyz/getting-started/token-registry)).

It is a good subject because it is more than a plain ERC-20: it is Circle's upgradeable `FiatTokenProxy`
with several admin roles, so the report can show *who controls the token*, not only its supply.

Any other contract works too (`--contract 0x...`); functions the contract does not implement are skipped.

## 1 · Agent: Claude Code + Pharos Chain MCP

A Claude Code agent is asked plain-English questions, one conversation ([`agent/prompts/`](agent/prompts)).
In the first message it **installs Pharos Chain MCP itself**; afterwards it can only use the Pharos MCP tools.

| # | You ask | What the agent did | Answer |
|---|---|---|---|
| 1 | "Hi! Please install the Pharos MCP server for yourself: https://mcp.pharos.xyz/mcp" | ran `claude mcp add --transport http -s project pharos https://mcp.pharos.xyz/mcp` → [`agent/.mcp.json`](agent/.mcp.json) | installed; tools load next turn |
| 2 | "Hey, are you hooked up to the Pharos chain? Which network are you on, and what's the latest block?" | Pharos MCP `get_chain_info` | chain 1672, latest block 20,414,351 |
| 3 | "There's a token contract at 0xC879…1815 on Pharos mainnet. What's it called? Please read it on-chain at block 20,399,245, …" | `eth_call` name(), symbol() | **USDC** |
| 4 | "How many of these tokens are out there? Give me the total supply in a format a normal person can read." | `eth_call` totalSupply(), decimals() | **41,609,740.342546 USDC** |
| 5 | "Who owns this contract?" | `eth_call` owner() | **0x9f8e…4d92** |
| 6 | "How much of it does 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819 hold?" | `eth_call` balanceOf() | **1,311,134 USDC** (~3.15% of supply) |
| 7 | "Sum it up for me in plain English: what is this token, and what do those numbers mean for someone who isn't a developer?" | — (uses the values above) | plain-English summary |

**Run it** (needs the signed-in `claude` CLI):

```bash
bash agent/run-agent.sh   # the conversation, saved as transcripts
bash agent/demo.sh        # the same conversation typed live in the terminal (used for the video)
```

Turn 1 may only run `claude mcp add`; every later turn runs with `--strict-mcp-config` and only the `pharos`
MCP server allowed (shell, file and web tools off), so every fact has to come from a Pharos Chain MCP call.

- [`agent/TRANSCRIPT.md`](agent/TRANSCRIPT.md) — readable: prompt → tool call with arguments → raw result → answer
- [`agent/transcripts/`](agent/transcripts) — the same as JSON Lines (sanitized: other MCP servers and local paths removed)

**Cross-check with the script.** All four values match the script's trace exactly
([`sample-trace.jsonl`](sample-trace.jsonl)). The script also reads what a single question doesn't: all admin roles,
and the ZeppelinOS proxy slots used by Circle's `FiatTokenProxy` (proxy admin `0x46f9…3F1b`, implementation `0xC35B…eAe8`).

## 2 · Script: deterministic MCP client

### What it reads (all at one pinned block)

| Value | How (MCP tool) |
|---|---|
| Chain id, latest block | `get_chain_info` |
| Block hash and time | `get_block` |
| Contract bytecode (proves a contract exists) | `get_code` |
| `name`, `symbol`, `decimals`, `totalSupply`, `currency`, `version`, `paused` | `eth_call` |
| Roles: `owner`, `masterMinter`, `pauser`, `blacklister`, `rescuer` | `eth_call` |
| Proxy admin and implementation | `get_storage_at` (ZeppelinOS slots, EIP-1967 fallback) |
| Optional balances (`--holder`) | `eth_call` → `balanceOf` |

Human formatting: decimals applied, digits grouped, every address labelled with its role and what that role
can do, the zero address shown as "not assigned", the block number and UTC time printed, plus an explorer link.

The block is pinned 3 blocks behind the head so that every value describes the same moment and the block is
already available on every RPC node behind the MCP server.

### Run

From the repository root (one shared install for all tasks):

```bash
npm install
npm run build
```

Then from this folder:

```bash
npm start                                   # USDC, latest block
npm start -- --block 20399245               # a specific block
npm start -- --holder 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819
npm start -- --contract 0x52c48d4213107b20bc583832b0d951fb9ca8f0b0   # WPROS
npm start -- --json                          # machine-readable output
npm start -- --trace trace.jsonl             # log every MCP tool call + raw response
```

The sample files were produced with
`npm start -- --block 20399245 --holder 0x40836f8f1bd7e13d99a4cc9de5c0b80a83109819 --trace sample-trace.jsonl`.

### Trace: every MCP call, as sent and as answered

[`sample-trace.jsonl`](sample-trace.jsonl) has one JSON line per Pharos Chain MCP tool call (18 calls): the tool
name, its arguments (for `eth_call`: target + ABI-encoded calldata, pinned block), the raw server response, and
for `eth_call` the decoded function and value. It shows that nothing is read outside MCP, e.g.:

```text
eth_call name()            -> "USDC"
eth_call totalSupply()     -> 41609740342546  (raw, 6 decimals -> 41,609,740.342546)
eth_call owner()           -> 0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92
eth_call balanceOf(0x4083…9819) -> 1311134000000 (-> 1,311,134 USDC)
```

No keys or wallets are needed: everything is read-only. The MCP client paces requests to stay under the
server's limit of 120 requests per minute per IP (`packages/pharos-mcp`).

### Sample output

See [`sample-output.txt`](sample-output.txt) (block 20,399,245, with one `--holder`):

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
  Status           Active — transfers are not paused

Who controls it
  0x9F8Ea09770Dc38fc61f5a62031b3BE0526D54D92  Owner — can reassign every role below
  0x908EA62d2529F31347d71992954E540A8d169603  Master Minter — decides who may mint new tokens
  0x828409Db274caD94AC10db6D54aeCa1Dbe00e237  Pauser — can freeze all transfers
  0xbA8Cd4958d4105Aaa23b00c645573F53fCd59486  Blacklister — can block individual addresses
  (not assigned)                              Rescuer — can recover tokens sent to the contract by mistake
  0x46f958BdEFfD33495E058873cDd114c79Ec13F1b  Proxy admin — can upgrade the contract code
  0xC35BEcB283fEC66626220467265F6d3B3f8cEae8  Implementation — the contract code currently in use

Balances
  0x40836f8F1bD7e13d99a4cc9DE5C0B80A83109819  1,311,134 USDC

In plain words
  At block 20,399,245 there were 41,609,740.342546 USDC in circulation on Pharos. Each token is meant to be worth 1 USD. Transfers are working normally.
  The address you interact with is an upgradeable proxy: its rules live in a separate implementation contract,
  and the proxy admin can swap that code. Special roles (owner, minter, pauser, blacklister) hold admin powers.

(18 Pharos MCP tool calls, contract bytecode 1798 bytes)
```

## Requirements checklist

- [x] Reads at least 3 different values from one contract via Chain MCP — the agent reads name, totalSupply, owner and a balance from plain-English prompts ([transcript](agent/TRANSCRIPT.md)); the script reads 13 values + 2 proxy slots ([trace](sample-trace.jsonl))
- [x] Shows the contract address and the block number the data was read at (plus block time and hash in `--json`)
- [x] Formats raw values for humans: decimals applied, addresses labelled
- [x] README: contract choice, how to run (agent and script), sample output and agent transcript
