# 03 · Docs MCP Onboarding (Developer Docs MCP · Easy)

Onboarding onto [ai.pharos.xyz](https://ai.pharos.xyz) using **only the Developer Docs MCP**, meaning the
`@Pharos Docs MCP` agent in the ai.pharos.xyz chat (the "Docs MCP" button). No other docs, no search engines, no
community help. Every answer below is the agent's real reply, copied from the chat on 2026-10-18 (full text in
[`log/`](log)). Then I checked each gap against the live services with [`src/verify-gaps.ts`](src/verify-gaps.ts).

**My goal:** build an agent that reacts to every buy on a bonding-curve token on Pharos mainnet, and let other
agents call it. That's the kind of thing I'd actually ask the docs, so I asked that instead of "what's the chain ID".

## Log

| # | What I wanted | Exact query to `@Pharos Docs MCP` | Answer (short) | Result |
|---|---|---|---|---|
| 0 | Figure out the site I just joined | *I just signed up on ai.pharos.xyz. What is this site, and what can I do here?* | after ~180 s the chat shows "Something went wrong. Please try again." (twice, on two accounts, [screenshot](log/q00-timeout.png)). The reply shows up in the history later: "`ai.pharos.xyz` **is not explicitly documented** as a specific site…", then some Anvita Flow info, cut off in the middle of a list ([screenshot](log/q00-late-reply.png)) | ✗ gap 1 |
| 1 | Pick the tool for my monitor | *I want my agent to react to every buy on a bonding-curve token launched on Pharos mainnet. Which Pharos MCP tool should it poll, and how many blocks can one call cover?* | `get_logs`, filter by address and event topic, max **1000 blocks** per call, go through bigger ranges in 1000-block windows. Endpoint `mcp.pharos.xyz/mcp`, 120 req/min | ✓ correct |
| 2 | Get the time of each trade | *Do logs from Pharos MCP include the block time, or does my bot need an extra call per block to know when a trade happened?* | "**get_logs does not include the block timestamp**", call `get_block` for each block and cache it | ✗ gap 2, wrong |
| 3 | Find contracts to index | *Is there an official list of launchpad or DEX factory contracts on Pharos mainnet that I could index, like FaroSwap or a token launchpad?* | No. The docs only list infra contracts (Create2Deployer, Multicall3, Safe, Permit2…) and suggests looking on the explorer or in each project's own docs and Discord | ✗ gap 3 |
| 4 | Let other agents use my monitor | *My monitor already runs as my own MCP server on a public URL. Can I publish it on Anvita Flow so other agents on ai.pharos.xyz can call it, or does it have to be a Skill?* | It has to be a Skill (a zip with `SKILL.md`) uploaded at flow.anvita.xyz/service-agents. You can't just give it your MCP URL. The console is allowlisted, pricing is in beta | ~ gap 4 |
| 5 | Charge per call | *Can my agent charge other agents per call with x402 on Pharos mainnet? Which token and contract address should the price be in?* | Yes. USDC `0xc879c018db60520f4355c26ed1a6d572cdac1815`, 6 decimals, network `eip155:1672`, scheme `exact`, with a full server example and the official skill repo | ✓ correct |
| 6 | Plan for more traffic | *The public Pharos MCP allows 120 requests a minute. Is there an API key or paid tier for production bots?* | No key, no paid tier. Self-host `pharos-mcp` (`RATE_LIMIT_PER_MINUTE`, `MCP_AUTH_TOKEN`, `PHAROS_RPC_URL`) and point it at a paid RPC "(Alchemy, **QuickNode**, ZAN…)" | ✓ mostly, ✗ gap 5 |

What worked: answers **1, 5 and 6** were complete and correct, I could copy them straight into code (the
1000-block window, the mainnet USDC address and x402 setup, the self-host env vars). **4** told me honestly that
the thing I wanted isn't possible yet, which was still useful.

## Gaps and how I'd fix them

**1. The docs don't cover ai.pharos.xyz, and the chat errors out on the question.**
Query 0 ended with "Something went wrong" after about 180 s, on two different accounts. The reply did come later
(I saw it in the history after a reload) and it confirms the gap: "`ai.pharos.xyz` is not explicitly documented as
a specific site". But it's cut off in the middle of a list ("**Chat with your Steward Agent"). Asking the Docs MCP
endpoint directly (`docs.pharos.xyz/~gitbook/mcp`, `askQuestion` "What is ai.pharos.xyz and what can I do there?")
gives the same picture: the docs only describe Anvita Flow at `flow.anvita.xyz`, "so I can't confirm that exact
domain's purpose" ([log/direct-docs-mcp.txt](log/direct-docs-mcp.txt)). The site has a similar issue: its llms.txt
page shows `https://www.pharos.xyz/agent-center/llms.txt`, which is a **404** (`docs.pharos.xyz/llms.txt` works).
*Fix:* add a page about ai.pharos.xyz: what it is, its agents (`@Pharos Docs MCP`, `@Pharos MCP`,
`@pharos-skill-engine`), the Guardian agent and credits, and how it relates to Anvita Flow. Have the chat say "not in
the docs" quickly instead of timing out. Fix the llms.txt link.

**2. "get_logs does not include the block timestamp" is wrong.**
The live Pharos MCP `get_logs` returns `blockTimestamp` on every log (`npm run verify` checks the latest blocks). If you
follow the docs you make an extra `get_block` call per block, and that eats into the 120 req/min limit.
*Fix:* show a real `get_logs` result with `blockTimestamp` on the Pharos MCP page, and add the field to the
JSON-RPC `eth_getLogs` example (right now it only appears in a receipt example).

**3. No list of ecosystem contracts.**
There's no list of DEX factories, routers or launchpads (FaroSwap, Prosper and so on), so anyone building an
indexer has to dig them up by hand. For task 02 I had to find the Prosper factory and work out its
`MarketCreated`/`Bought`/`Sold` event signatures myself.
*Fix:* an "Ecosystem contracts" page next to Canonical Contracts with protocol, contract, address, ABI link and
the main event topics.

**4. You can't publish an MCP server you already run.**
Anvita Flow only takes a zipped Skill. A working remote MCP endpoint can't be listed, and the developer console is
allowlisted ("contact the Pharos team").
*Fix:* document how to make a Skill that's just a thin wrapper around your MCP server, with a small `SKILL.md`
example, plus how to get console access. Or let people register a remote MCP URL as a Service Agent.

**5. The agent recommends a provider that doesn't list Pharos.**
Answer 6 recommends "Alchemy, **QuickNode**, ZAN", but the RPC page lists only **ZAN, Nirvana and Alchemy**.
I also checked QuickNode itself (2026-10-19): Pharos isn't in their docs index (`quicknode.com/docs/llms.txt`),
`quicknode.com/docs/pharos` is a 404, and `quicknode.com/chains/pharos` is just the generic page they show for any
unknown slug. So as far as public info goes, QuickNode doesn't offer Pharos and someone following this answer would
hit a dead end. `npm run verify` checks both sides. (Private or enterprise deals can't be checked from outside.)
*Fix:* take provider lists only from the RPC Infrastructure page, and mention the Nirvana dev key, since that's
the documented way to get more than 120/min.

**6. The `eth_getLogs` block limit is documented in two different ways.**
Asking the Docs MCP directly ("What is the maximum block range for eth_getLogs on the Pharos RPC?") gives "100
blocks with rate limiting, 10,000 fallback" (from the JSON-RPC page) and "1000" for MCP. In answer 6 the chat agent
calls 1000 "an upstream RPC limit". On the live `rpc.pharos.xyz`, 101 blocks work and 1001 blocks fail with
*"narrowing it down to within 1,000 blocks"*.
*Fix:* one number, 1000, on the JSON-RPC page.

## What I built and ran in the end

Using answers 1, 3 and 6 (and the fix for 2), the monitor from task 02 is running:

- **CLI monitor** ([`02-event-log-monitor`](../02-event-log-monitor)): `get_logs` over the curve markets with the
  Bought/Sold topics, 1000-block windows, and `blockTimestamp` taken right from the logs (no `get_block` calls).
- **Hosted feed and its own MCP server** ([`services/prosper-monitor`](../services/prosper-monitor)):
  https://mcp.pharosfdv.xyz/prosper-monitor and `…/prosper-monitor/mcp`. It indexes every Prosper curve 24/7
  and stays within the public 120 req/min.
- Next, based on answer 4: wrap that MCP server in a Skill so it can go on Anvita Flow (needs console access).

## Check it yourself

From the repo root: `npm install && npm run build`, then:

```bash
npm run verify --workspace 03-docs-mcp-onboarding
```

```text
✓ Pharos MCP get_logs: 31/31 logs carry blockTimestamp (docs: "get_logs does not include the block timestamp")
  rpc.pharos.xyz eth_getLogs over 101 blocks: ok (15 logs)
  rpc.pharos.xyz eth_getLogs over 1001 blocks: rejected (param error; The block range is too large. Consider narrowing it down to within 1,000 blocks.)
✓ llms.txt: www.pharos.xyz/agent-center/llms.txt → 404, docs.pharos.xyz/llms.txt → 200
✓ docs RPC providers: ZAN RPC, Nirvana RPC, Alchemy RPC, no QuickNode
✓ QuickNode docs: no mention of Pharos in docs/llms.txt, quicknode.com/docs/pharos → 404
```

## Tests

`npm test` makes sure the log is honest: every query in the table has to match the query saved in `log/`, and
every quoted reply has to be in the saved reply word for word ([`src/log.test.ts`](src/log.test.ts)).
