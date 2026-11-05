# 18 · Docs MCP + Chain MCP Agent

**nerd** is an agent skill that won't say a word about a Pharos contract function until it has read the
official docs. You name a function; nerd searches the Pharos developer docs through the Docs MCP, prints the
lines that talk about it word for word with their links, then calls that same function on Pharos mainnet
through the Chain MCP, and then holds the chain's answer up against what the docs promised. Every promise ends
up as MATCH, DIFFERENT, DOCS SILENT or CHAIN SAYS NO, with the docs line and the chain value side by side.

It is read-only: `eth_call` and `estimate_gas`, never a signature. The order is enforced, not just advised:
`nerd call` refuses to run until `nerd docs` has read the docs for the same target.

How it works, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## Why "promises"

Docs rarely explain a function in a sentence you can check. What they do give is concrete values: a token's
EIP-712 name and version, a number of decimals, a domain id, a byte layout. Those are promises, and a contract
either keeps them or it doesn't. So nerd pulls those values out of the page text at run time (nothing is typed
into the code), calls the function, and compares. When the docs are silent, nerd says so instead of guessing.

## What it knows how to check

| Target | Docs page | Function | What the docs promise |
|---|---|---|---|
| `x402-domain` | [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet) | USDC `DOMAIN_SEPARATOR()`, `name()`, `version()` | x402 signs with EIP-712 name "USDC", version "2", chain 1672, token `0xc879...1815`. nerd rebuilds the separator from those four values. |
| `x402-decimals` | same | USDC `decimals()` | "6 decimals precision", worked example `0.01 -> "10000"`, prices 0.01 and 0.005 in the server example |
| `cctp-send` | [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp) | `MessageTransmitterV2.sendMessage(...)`, `localDomain()`, `version()` | Pharos is domain 31, `finalityThresholdExecuted >= 2000` is finalized, "use 1 for CCTP", the message header byte layout |
| `--to --sig` | whatever the search finds | any function | whatever the pages say about it |
| `--tx` (from `nerd first`) | whatever the search finds | the function a real transaction called | usually nothing: most contracts on chain are not in the docs |

`cctp-send` is a simulation only. Next to it nerd pulls the newest real `MessageSent` event from the same
contract and cuts it along the docs' offset table, so you can see what a sent message really looks like without
sending one.

## Quick start

```bash
cd 18-nerd && npm ci && npm run build
node skill/nerd/scripts/nerd.mjs docs x402-domain
node skill/nerd/scripts/nerd.mjs call x402-domain
node skill/nerd/scripts/nerd.mjs read x402-domain
```

The skill itself is `skill/nerd/` (SKILL.md plus one bundled script, no install). Any agent that loads it runs
the three steps in order and explains the result only from the quoted lines.

```bash
node skill/nerd/scripts/nerd.mjs docs cctp-send --dest 0 --from 0xYourAddress
node skill/nerd/scripts/nerd.mjs call cctp-send --dest 0 --from 0xYourAddress
node skill/nerd/scripts/nerd.mjs read cctp-send --dest 0 --from 0xYourAddress
node skill/nerd/scripts/nerd.mjs first
```

Every MCP call is printed while it happens (server, tool, arguments, milliseconds).

## What a reading looks like

From a run on 2026-11-05 at block 22183339:

```text
Reading: DOMAIN_SEPARATOR() of the USDC token x402 payments use on Pharos
  MATCH         EIP-712 name the docs sign with vs token name()
                docs [1]: const usdcName = process.env.USDC_NAME || "USDC";
  MATCH         EIP-712 version the docs sign with vs token version()
                docs [1]: version: "2",
  MATCH         DOMAIN_SEPARATOR built from the docs (name "USDC", version "2", chain 1672, token 0xc879...1815) vs DOMAIN_SEPARATOR()
                docs value:  0x6ffe34d160f3b60b5ec680c84efc558f4ae78067d11d292a535aaf7fb0155232
                chain value: 0x6ffe34d160f3b60b5ec680c84efc558f4ae78067d11d292a535aaf7fb0155232
in plain words:
  A payment signed with exactly the settings in the docs lands in the same EIP-712 domain this token checks
  signatures in, so it will verify.
```

## Things the chain told us that the docs don't

- `sendMessage` refuses Pharos' own domain ("Domain is local domain") and a zero recipient ("Recipient must be
  nonzero"), but takes domain 999 without complaint: the contract does not check that a domain exists. The
  Pharos page lists only domain 31 and links Circle's list for the rest, so picking a real one is on the caller.
- A message leaving Pharos carries an all-zero nonce. That fits the docs' line that Circle assigns CCTP nonces
  offchain.
- Of 99 transactions in 300 recent blocks, 7 went to an address a docs page lists (all USDC `approve` and
  `transferFrom`), and the pages that list USDC never name either function. `nerd first` usually ends in DOCS SILENT, and that is the honest answer.

## Limits

- The Docs MCP search decides which pages nerd opens. A page the search does not return is not read.
- The value parsers know the x402 and CCTP pages' current wording. If the docs are rewritten, a value can go
  missing, and the reading then says DOCS SILENT for it rather than inventing one.
- `askQuestion` (the docs' own language model) is not used: it can answer from general knowledge, and nerd only
  trusts lines it can quote from a page.
- Chain MCP `get_logs` takes at most 1,000 blocks per call, so the real-message lookup goes back 10,000 blocks.

## Tests

`npm test`: 20 tests on the real docs page text (fixtures saved from the Docs MCP on 2026-11-05) and a scripted
MCP server: value parsing, quotes being verbatim lines, the docs-first rule, the EIP-712 separator against the
value USDC returned on mainnet, prices to base units, sendMessage success and refusal, cutting a real message by
the docs' offsets, the latest-block walk.

## Proof

A real agent session recorded on 2026-11-05 (Claude Code with the skill installed from this repo by the agent
itself, five turns, Pharos mainnet, read-only). In every turn the agent ran `docs`, then `call`, then `read`, and
explained the function only from the quoted docs lines, with their links.

| Turn | The user asked | Docs MCP read | Chain MCP called (block) | Reading |
|---|---|---|---|---|
| 2 | does USDC's DOMAIN_SEPARATOR match what the x402 docs sign with? | [x402 Pacific Mainnet](https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet), [x402 Atlantic Testnet](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet) | USDC `name()`, `version()`, `DOMAIN_SEPARATOR()` (22187241) | MATCH x3: "USDC", "2", separator `0x6ffe34d1...5232` rebuilt from the docs equals the chain's |
| 3 | how much USDC moves for a 0.01 call? | x402 Pacific Mainnet | USDC `decimals()` (22187286) | MATCH: 6 decimals; the docs' `0.01 -> "10000"` redone with the chain's decimals gives 10000; 0.005 is 5000 base units |
| 4 | could I send a CCTP message from my wallet to domain 0? simulate only, explain each parameter | [Circle CCTP](https://docs.pharos.xyz/tooling-and-infrastructure/cross-chain/circle-cctp) | `localDomain()`, `version()`, `sendMessage` eth_call from `0x4644...D3Bb`, estimate_gas, newest `MessageSent` (22187321) | MATCH domain 31, version 1; simulation goes through, 47,803 gas; DOCS SILENT on which chain domain 0 is; the real message in [`0x9c69c43a...1eef`](https://www.pharosscan.xyz/tx/0x9c69c43a7365656ef1ef64c136fa9ff312986770a9236731d4528498a12d1eef) (block 22187272) cut by the docs' table: source 31, version 1, sender TokenMessengerV2 `0x28b5...cf5d`, all MATCH |
| 5 | grab the first function call in the latest blocks and explain it | searches for the contract and the selector: nothing | `first` walked back to [`0xafed5faf...2192`](https://www.pharosscan.xyz/tx/0xafed5fafbb87836a1f21b933e6e3bb18cc3cb6a53880dc754d7a3830afa42192) (block 22187364), replayed as its sender at 22187363 | DOCS SILENT x2: the docs list neither `0x9365...b470` nor a function with selector `0x2f139e4f`; the agent said so and did not guess |

Nothing was signed or sent in the whole session.
