# nerd: reads the Pharos docs first, then calls the function, then holds the answer up against what it read

Task: Pharos Agent Arena "Docs MCP + Chain MCP Agent" (Medium, 100 + 50 video),
https://pharos-agent-arena.vercel.app/tasks/docs-chain-mcp-agent

> An agent that explains and then acts. Given a contract function, it uses Developer Docs MCP to explain what the
> function does and its parameters, then calls it via Chain MCP and interprets the result.

## Why

All three leaders (see `docs/arena-competitors.md`, section 18) read price feeds or ERC-20 getters and print the
number with a unit. nerd treats the docs as a set of concrete promises (a name, a version, a scale, a domain id, a
byte layout) and the chain call as the test of those promises. The output is "the docs say X (link), the chain says
Y, so this is what it means for you", and a function the docs never name gets an honest "not in the docs".

## Verified facts this design rests on (Pharos mainnet, 2026-11-05)

Docs MCP `https://docs.pharos.xyz/~gitbook/mcp`: tools `searchDocumentation(query)`, `getPage(url)`,
`askQuestion(question)`, `sendFeedback`. Plain JSON-RPC POST works.
Chain MCP `https://mcp.pharos.xyz/mcp`: `get_block_number`, `get_block(block, includeTransactions)`, `get_code`,
`eth_call(transaction, block)`, `estimate_gas(transaction)`, `get_logs`, ... (needs an MCP session).

x402 pages (`/developer-guide/x402`, `/x402-pacific-mainnet`, `/x402-atlantic-testnet`) name no Solidity function.
They give values: USDC `0xc879c018db60520f4355c26ed1a6d572cdac1815`, network `eip155:1672`, "USDC (6 decimals
precision)" with `0.01 -> "10000"`, EIP-712 `extra: { name: usdcName (default "USDC"), version: "2" }`, prices
0.01 and 0.005.
- USDC `name()` = "USDC", `version()` = "2", `decimals()` = 6.
- USDC `DOMAIN_SEPARATOR()` = `0x6ffe34d1...5232`, equal to keccak256(abi.encode(keccak("EIP712Domain(string name,
  string version,uint256 chainId,address verifyingContract)"), keccak("USDC"), keccak("2"), 1672, USDC)).
- `eip712Domain()` reverts on this USDC.

Circle CCTP page (`/tooling-and-infrastructure/cross-chain/circle-cctp`): MessageTransmitterV2
`0x81D40F21F12A8F0E3252Bccb954D722d4c464B64`, Pharos Domain 31, `MessageTransmitterV2#sendMessage` is how an
arbitrary message is sent, `finalityThresholdExecuted >= 2000` = finalized, message header table with byte offsets
(version 0 "use 1 for CCTP", sourceDomain 4, destinationDomain 8, nonce 12, sender 44, recipient 76,
destinationCaller 108, minFinalityThreshold 140, finalityThresholdExecuted 144, messageBody 148).
- `localDomain()` = 31, `version()` = 1, `maxMessageBodySize()` = 8192.
- `eth_call sendMessage(0, <wallet as bytes32>, 0x0, 2000, "h")` from the test wallet succeeds; estimate 47,247 gas.
- destination 31 reverts "Domain is local domain"; zero recipient reverts "Recipient must be nonzero";
  destination 999 does NOT revert (the contract does not check that a domain exists).
- The Pharos page does not list other chains' domain ids; it links Circle's list.
- Real `MessageSent(bytes)` events (topic `0x8c526166...b036`) on this contract: 134 in the last 150,000 blocks,
  newest at block 22180628 (tx `0x6eec53a3...14bf`). Cut by the docs offsets it reads: version 1, sourceDomain 31,
  destinationDomain 0, nonce all zeros (the docs: "Circle assigns CCTP nonces offchain"), sender = recipient =
  TokenMessengerV2 `0x28b5...cf5d` (the docs address), minFinalityThreshold 1000, finalityThresholdExecuted 0,
  body starts with the USDC address (a burn message). Public RPC caps `eth_getLogs` at 1,000 blocks per call.

So run 3 can show what a sent message looks like without sending one: nerd fetches the newest real `MessageSent`
through Chain MCP `get_logs` and cuts it with the docs table, next to the simulation of the user's own call.

Last 300 blocks (head 22180111): 219 empty, 99 txs, 7 to an address any docs page lists (USDC approve /
transferFrom), and no docs page names approve or transferFrom.

## Demo functions (user's choice)

1. x402 / USDC `DOMAIN_SEPARATOR()`: the docs give name, version, chain, token; nerd builds the expected separator
   from those quoted values and compares it with the chain. MATCH means a payment signed with the docs' settings
   will verify on this token.
2. x402 / USDC `decimals()`: the docs say 6 and show 0.01 -> 10000; nerd reads decimals and turns the docs' prices
   (0.01, 0.005) into the base units a payment will carry.
3. CCTP `MessageTransmitterV2.sendMessage(...)`: simulation only (user's choice): `eth_call` + `estimate_gas` via
   Chain MCP from the caller address, read against the docs (local domain 31, finality 2000, header layout).
   No transaction is sent.
4. "Take the first function you meet in the latest blocks and explain it": nerd walks back from the head through
   Chain MCP `get_block`, takes the first tx with calldata, searches the docs for the contract address and for the
   selector among the functions the docs name, and says "not in the docs" when nothing matches.

## Commands

All output is plain text for the agent plus `--json`. Every MCP call is printed as it happens (tool, args, ms).

- `nerd docs <topic|address|function>`: Docs MCP `searchDocumentation`, then `getPage` on the hits; returns quoted
  lines (verbatim, with the page URL) that mention the asked thing. Writes a brief to `$NERD_HOME/briefs/<id>.json`.
- `nerd call <preset|--to --sig [args]>`: Chain MCP `eth_call` (and `estimate_gas` for non-view). Refuses without a
  brief for the same target written in this run (the order is enforced, not just advised).
- `nerd read <id>`: deterministic reading of brief + call: each docs promise gets MATCH / DIFFERENT / DOCS SILENT,
  with the quote and link next to it.
- `nerd first [--max-blocks N]`: the latest-block walk for run 4.
- Presets: `x402-domain`, `x402-decimals`, `cctp-send`. Any contract + signature also works.

`askQuestion` is not a source of facts (it is a language model and can answer from general knowledge). nerd may
show its answer, but only quotes from `getPage` count as the explanation.

## The skill

`skill/nerd/SKILL.md`: the order is docs -> call -> read; the explanation is built only from quoted lines with
their links; parameters are explained from the docs; anything the docs do not say is said as "the docs do not say";
never sends a transaction (there is no signing code at all).

## Layout (like 17-kickback)

`18-nerd/`: `src/` (mcp clients, docs grounding, abi, presets, reading, first-in-blocks, cli), `skill/nerd/`,
`agent/` (demo.sh, prompts 01-install .. 05, pretty-stream), `README.md` with `## Proof`, `ARCHITECTURE.md`
(mermaid sequence). TypeScript, `@modelcontextprotocol/sdk`, `viem` (abi + keccak), node:test.

## Demo prompts (user plays a newbie; agent explains itself)

01 install Pharos MCP; 02 "what is DOMAIN_SEPARATOR on the USDC x402 uses and does it match what the docs say";
03 "how much will a $0.01 x402 call actually move in USDC"; 04 "could I send a CCTP message from my wallet to
domain 0, just simulate it"; 05 "take the first function you meet in the latest blocks and explain it".

## Tests

Grounding (quote must be a verbatim line of the fetched page), order enforcement, separator math against the
verified value, decimals conversion, sendMessage reading (success, known revert strings), first-in-blocks
(skips empty blocks / plain transfers, "not in docs" path), MCP calls with a fake transport.

## Non-goals

No transactions, no keys, no LLM inside nerd, no signature databases outside the docs and the chain.
