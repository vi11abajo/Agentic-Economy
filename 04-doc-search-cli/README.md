# 04 · Doc-Search CLI (Developer Docs MCP · Easy)

**rtfm** reads the manual so you don't have to. Ask the Pharos docs a question from your terminal and get a
short answer with links to the pages it came from. It runs on the Developer Docs MCP
(`https://docs.pharos.xyz/~gitbook/mcp`).

And since the manual is sometimes wrong (see task 03), it can also check the answer against the chain.

Two things it does on top of a plain wrapper:

- **It says so when the docs don't know.** If the Docs MCP can't answer, rtfm doesn't print a made-up answer.
  It tells you there's no answer in the docs, shows what the Docs MCP said, lists the closest pages from a docs
  search and exits with code 2, so scripts can tell.
- **`--verify` checks the answer on the chain.** In task 03 I found answers where the docs were just wrong. With
  `--verify`, rtfm pulls the checkable facts out of the answer (contract addresses, chain IDs, block limits)
  and checks them on Pharos mainnet through Pharos Chain MCP: is there a contract at that address and what does
  `symbol()` return, is it the mainnet chain ID, how many blocks does `get_logs` really accept. Each fact gets
  ✓, ✗ or ! (can't be checked on mainnet, e.g. a testnet address).

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

**2. Go to the CLI folder:**

```bash
cd 04-doc-search-cli
```

**3. Ask something.** The docs agent takes 20 to 40 seconds to answer, `--verify` adds a few seconds of chain
checks:

```bash
npx --no-install rtfm "How many blocks can a single eth_getLogs call span on the public Pharos RPC?" --verify
```

`--no-install` makes npx run this local command and never download some other package called rtfm. Run it
from inside `04-doc-search-cli`: right after a fresh `npm ci` the command isn't linked in the repo root yet.

**4. Make `rtfm` a normal command** so you can drop the `npx --no-install`. Once, from `04-doc-search-cli`:

```bash
npm link
```

Now from any folder, quotes are optional:

```bash
rtfm how do I confirm a transaction from the cli
```

To remove it again:

```bash
npm unlink -g rtfm
```

Or skip the global link and add a shell alias instead (fix the path if you cloned somewhere else):

```bash
echo "alias rtfm='node $HOME/Agentic-Economy/04-doc-search-cli/dist/cli.js'" >> ~/.bashrc && source ~/.bashrc
```

**5. Turn on-chain checks on for every question** (saved, so you don't have to add `--verify` each time):

```bash
rtfm --verify-on
```

Turn them off again with `rtfm --verify-off`, see the current setting with `rtfm --verify-status`. For one question
`--verify` or `--no-verify` still wins over the setting.

**About quotes.** The shell reads the line before rtfm sees it, so a question with an apostrophe (`what's`,
`don't`) or with `! & | ; < >` needs quotes. In zsh a `?` needs them too (or `alias rtfm='noglob rtfm'`). The easy
way around all of that: run just `rtfm`, it asks `Ask:` and takes the question exactly as you type it. That's one
question and then it exits, not a chat.

While it waits, one line shows a random phrase and the seconds so far ("Dusting off the manuals… 12s"). It goes
to stderr and only to a real terminal, so `--json` and piped output stay clean.

The wording of answers changes a little from run to run, they come from the docs agent.

## Usage

```text
rtfm <question> [--verify | --no-verify] [--full] [--sources N] [--json]
rtfm                                ask one question at an "Ask:" prompt (no quoting needed)
rtfm --verify-on | --verify-off     check answers on-chain by default, or stop (saved)
rtfm --verify-status                show that setting
rtfm search <words>                 list matching doc pages
rtfm page <docs.pharos.xyz URL>     print a whole page

--verify     check addresses, chain IDs and block limits from the answer on Pharos mainnet
--no-verify  skip the check for this question even if --verify-on is set
--full       print the whole answer instead of the first few paragraphs
--sources N  how many source links to show (default 3)
--json       machine-readable output

Exit codes: 0 answered, 2 the docs have no answer, 1 error.
```

The setting lives in `~/.config/rtfm/config.json` (`%APPDATA%\rtfm\config.json` on Windows), or wherever
`RTFM_CONFIG` points.

## Examples

Real runs from 2026-10-19 (also in [`examples/`](examples)). The answers come from the docs agent, so the wording
changes a bit from run to run.

**1. A contract address, confirmed on-chain**

```text
$ rtfm "I want gasless onboarding with ERC-4337 smart accounts on Pharos mainnet. Which EntryPoint should my bundler target?" --verify
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

The docs say 100 blocks (10,000 as a fallback). The chain accepts up to 1,000, and 1,001 gets rejected. rtfm
finds the real number with a few `get_logs` calls.

```text
$ rtfm "How many blocks can a single eth_getLogs call span on the public Pharos RPC before it gets rejected?" --verify
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
$ rtfm "My agent wants to charge 1 cent per call with x402 on Pharos mainnet. Which asset address goes into the payment requirements?" --verify
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
$ rtfm "Does Pharos mainnet support EIP-7702, so an EOA can delegate to a smart account code?" --verify
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

1. `askQuestion` on the Docs MCP. The reply is markdown that ends with a list of source links; rtfm splits
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
against a fake chain with a 1,000-block limit ([`src/rtfm.test.ts`](src/rtfm.test.ts)). Plus the command line
(questions without quotes, `--verify-on/off`, the saved setting) and the waiting line
([`src/cli-options.test.ts`](src/cli-options.test.ts)).
