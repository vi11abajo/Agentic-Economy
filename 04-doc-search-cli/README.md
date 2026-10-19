# 04 · Doc-Search CLI (Developer Docs MCP · Easy)

**foghorn** asks the Pharos docs a question from your terminal and gives you a short answer with links to the
pages it came from. It runs on the Developer Docs MCP (`https://docs.pharos.xyz/~gitbook/mcp`).

Pharos is a lighthouse, so the CLI is its foghorn: you ask into the fog, it answers.

Two things it does on top of a plain wrapper:

- **It says so when the docs don't know.** If the Docs MCP can't answer, foghorn doesn't print a made-up answer.
  It tells you there's no answer in the docs, shows what the Docs MCP said, lists the closest pages from a docs
  search and exits with code 2, so scripts can tell.
- **`--verify` checks the answer on the chain.** In task 03 I found answers where the docs were just wrong. With
  `--verify`, foghorn pulls the checkable facts out of the answer (contract addresses, chain IDs, block limits)
  and checks them on Pharos mainnet through Pharos Chain MCP: is there a contract at that address and what does
  `symbol()` return, is it the mainnet chain ID, how many blocks does `get_logs` really accept. Each fact gets
  ✓, ✗ or ! (can't be checked on mainnet, e.g. a testnet address).

## Install

From the repo root (one install for all tasks):

```bash
npm install
npm run build
npx foghorn "how do I verify a contract on Pharos?"
```

`npx foghorn` works anywhere inside the repo. To get a plain `foghorn` command everywhere, run `npm link` in
`04-doc-search-cli`. No keys needed.

## Usage

```text
foghorn "<question>" [--verify] [--full] [--sources N] [--json]
foghorn search "<words>"              list matching doc pages
foghorn page <docs.pharos.xyz URL>     print a whole page

--verify     check addresses, chain IDs and block limits from the answer on Pharos mainnet
--full       print the whole answer instead of the first few paragraphs
--sources N  how many source links to show (default 3)
--json       machine-readable output

Exit codes: 0 answered, 2 the docs have no answer, 1 error.
```

## Examples

Real runs from 2026-10-19 (also in [`examples/`](examples)). The answers come from the docs agent, so the wording
changes a bit from run to run.

**1. A contract address, confirmed on-chain**

```text
$ foghorn "I want gasless onboarding with ERC-4337 smart accounts on Pharos mainnet. Which EntryPoint should my bundler target?" --verify
For Pharos Pacific Mainnet, target the canonical ERC-4337 EntryPoint v0.7:

`0x0000000071727De22E5E9d8BAf0edAc6f37da032`

Pharos also lists a v0.6 EntryPoint at `0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789`; use it only if your smart-account stack specifically requires v0.6. See Canonical Contracts.

Sources
  1. Canonical Contracts  https://docs.pharos.xyz/getting-started/canonical-contracts
  2. x402 Pacific Mainnet  https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet
  3. About Pharos  https://docs.pharos.xyz/introduction/readme

Checked on Pharos mainnet (chain 1672, block 20,681,551, via Pharos Chain MCP)
  ✓ 0x0000…a032: contract on mainnet
  ✓ 0x5ff1…2789: contract on mainnet
(exit code 0)
```

**2. The docs give the wrong limit, the chain corrects it**

The docs say 100 blocks (10,000 as a fallback). The chain accepts up to 1,000, and 1,001 gets rejected. foghorn
finds the real number with a few `get_logs` calls.

```text
$ foghorn "How many blocks can a single eth_getLogs call span on the public Pharos RPC before it gets rejected?" --verify
Use a maximum of 100 blocks per `eth_getLogs` call on the rate-limited public RPC. The documented
fallback cap is 10,000 blocks when rate limiting isn’t enabled. See JSON-RPC API Methods.

Sources
  1. JSON-RPC API Methods  https://docs.pharos.xyz/api-and-sdk/json-rpc-methods
  2. Rollback Blocks  https://docs.pharos.xyz/node-and-validator-guide/rollback-blocks
  3. Block Explorer  https://docs.pharos.xyz/tooling-and-infrastructure/block-explorer

Checked on Pharos mainnet (chain 1672, block 20,681,576, via Pharos Chain MCP)
  ✗ 100 blocks per get_logs call: the real limit is 1,000 blocks (1,001 get rejected)
  ✗ 10,000 blocks per get_logs call: the real limit is 1,000 blocks (1,001 get rejected)
(exit code 0)
```

**3. A token address, checked with `symbol()`**

```text
$ foghorn "My agent wants to charge 1 cent per call with x402 on Pharos mainnet. Which asset address goes into the payment requirements?" --verify
For Pharos Pacific Mainnet, set the payment requirement’s `asset` to the USDC contract address:

0xc879c018db60520f4355c26ed1a6d572cdac1815

For $0.01 USDC, use `amount: "10000"` (USDC has 6 decimals) and network `eip155:1672`. See x402 Pacific Mainnet.

Sources
  1. x402 Pacific Mainnet  https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet
  2. x402 Atlantic Testnet  https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet
  3. x402  https://docs.pharos.xyz/developer-guide/x402

Checked on Pharos mainnet (chain 1672, block 20,681,601, via Pharos Chain MCP)
  ✓ 0xc879…1815: contract on mainnet, symbol() = USDC
(exit code 0)
```

**4. Not in the docs, nothing to verify**

```text
$ foghorn "Does Pharos mainnet support EIP-7702, so an EOA can delegate to a smart account code?" --verify
No answer in the Pharos docs for this.
Docs MCP: "I can’t confirm EIP-7702 support on Pharos Pacific Mainnet from the available docs."

Closest pages
  1. x402 Pacific Mainnet  https://docs.pharos.xyz/developer-guide/x402/x402-pacific-mainnet
  2. Pharos MCP  https://docs.pharos.xyz/tooling-and-infrastructure/mcp
  3. Validator Accountability  https://docs.pharos.xyz/node-and-validator-guide/validator-accountability

Nothing to verify on-chain: there is no answer to check.
(exit code 2)
```

## How it works

1. `askQuestion` on the Docs MCP. The reply is markdown that ends with a list of source links; foghorn splits
   the two, turns the markdown into plain text and keeps the first few paragraphs (`--full` shows everything).
2. If the first sentence says the docs don't cover it ("I cannot find…", "I can't confirm…", "the documentation
   does not…"), it's treated as no answer. Only the first sentence counts, so an answer like "It has to be a
   Skill. Anvita Flow does not provide…" still counts as an answer. In that case the sources shown are from
   `searchDocumentation`, which is more useful than the pages the agent happened to look at.
3. `--verify` reads the facts with regexes and checks them with Pharos Chain MCP: `get_chain_info`,
   `get_code`, `eth_call` (`symbol()`/`name()`) and `get_logs` on N and N+1 blocks. If a limit is wrong it finds
   the real one by doubling and then bisecting, about a dozen calls.

Code: [`src/cli.ts`](src/cli.ts), [`src/answer.ts`](src/answer.ts), [`src/verify.ts`](src/verify.ts),
[`src/docs.ts`](src/docs.ts).

## Tests

`npm test` runs on real Docs MCP replies saved in [`test/fixtures/`](test/fixtures): splitting answers from
sources, spotting "no answer" without false alarms, plain-text output, finding claims, and the on-chain checks
against a fake chain with a 1,000-block limit ([`src/foghorn.test.ts`](src/foghorn.test.ts)).
