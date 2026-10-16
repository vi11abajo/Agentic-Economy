# 01 · Read Contract State (Chain MCP · Easy)

Reads live state of a deployed Pharos contract **through Pharos Chain MCP** (`https://mcp.pharos.xyz/mcp`)
and explains it in plain language for a non-developer.

## Contract

**USDC on Pharos Pacific Mainnet** — `0xC879C018dB60520F4355C26eD1a6D572cdAC1815`
(listed as "USDC (Circle Deployed)" in the [Pharos Token Registry](https://docs.pharos.xyz/getting-started/token-registry)).

It is a good subject because it is more than a plain ERC-20: it is Circle's upgradeable `FiatTokenProxy`
with several admin roles, so the report can show *who controls the token*, not only its supply.

Any other contract works too (`--contract 0x...`); functions the contract does not implement are skipped.

## What it reads (all at one pinned block)

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

## Run

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

## Trace: every MCP call, as sent and as answered

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

## Sample output

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

- [x] Reads at least 3 different values from one contract via Chain MCP (13 values incl. a balance + 2 proxy slots; see the trace)
- [x] Shows the contract address and the block number the data was read at (plus block time and hash in `--json`)
- [x] Formats raw values for humans: decimals applied, addresses labelled
- [x] README: contract choice, how to run, sample output
