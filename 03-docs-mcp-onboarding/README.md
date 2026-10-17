# 03 · Docs MCP Onboarding (Developer Docs MCP · Easy)

Onboarding onto [ai.pharos.xyz](https://ai.pharos.xyz) using **only the Developer Docs MCP** — the
`@Pharos Docs MCP` agent in the ai.pharos.xyz chat (the "Docs MCP" button). No external docs, search engines or
community help. Every answer below is the agent's real reply, copied from the chat on 2026-10-18 (full text in
[`log/`](log)); every gap was then checked against the live services with [`src/verify-gaps.ts`](src/verify-gaps.ts).

**My goal for the session:** ship an agent that reacts to every buy on a bonding-curve token on Pharos mainnet,
and make it callable by other agents. That is the kind of question a builder actually brings — so the questions
follow that path instead of "what is the chain ID".

## Step-by-step log

| # | What I was trying to do | Exact query to `@Pharos Docs MCP` | Answer (short) | Verdict |
|---|---|---|---|---|
| 0 | Understand the site I just joined | *I just signed up on ai.pharos.xyz. What is this site, and what can I do here?* | no answer — after ~180 s: "Something went wrong. Please try again." (twice, on two accounts; [screenshot](log/q00-timeout.png)) | ✗ gap 1 |
| 1 | Pick the tool for my monitor | *I want my agent to react to every buy on a bonding-curve token launched on Pharos mainnet. Which Pharos MCP tool should it poll, and how many blocks can one call cover?* | `get_logs`, filter by address + event topic, max **1,000 blocks** per call, page in 1,000-block windows; endpoint `mcp.pharos.xyz/mcp`, 120 req/min | ✓ correct |
| 2 | Get the trade time | *Do logs from Pharos MCP include the block time, or does my bot need an extra call per block to know when a trade happened?* | "**No — get_logs does not include the block timestamp**"; call `get_block` per distinct block and cache | ✗ gap 2 (wrong) |
| 3 | Find the contracts to index | *Is there an official list of launchpad or DEX factory contracts on Pharos mainnet that I could index, like FaroSwap or a token launchpad?* | No — the docs only list infrastructure contracts (Create2Deployer, Multicall3, Safe, Permit2…); "go to the explorer / project Discord" | ✗ gap 3 |
| 4 | Publish my monitor for other agents | *My monitor already runs as my own MCP server on a public URL. Can I publish it on Anvita Flow so other agents on ai.pharos.xyz can call it, or does it have to be a Skill?* | It has to be a Skill (zip with `SKILL.md`), uploaded at flow.anvita.xyz/service-agents; no "bring your own MCP URL"; console is allowlisted; pricing in beta | ~ gap 4 |
| 5 | Charge per call | *Can my agent charge other agents per call with x402 on Pharos mainnet? Which token and contract address should the price be in?* | Yes — USDC `0xc879c018db60520f4355c26ed1a6d572cdac1815`, 6 decimals, network `eip155:1672`, scheme `exact`, full server snippet + official skill repo | ✓ correct |
| 6 | Plan for production load | *The public Pharos MCP allows 120 requests a minute. Is there an API key or paid tier for production bots?* | No key, no paid tier — self-host `pharos-mcp` (`RATE_LIMIT_PER_MINUTE`, `MCP_AUTH_TOKEN`, `PHAROS_RPC_URL`), point it at a paid RPC "(Alchemy, **QuickNode**, ZAN…)" | ✓ mostly, ✗ gap 5 |

Where the docs got me unstuck: **1, 5 and 6** gave complete, correct, copy-pasteable answers (the 1,000-block
window, the mainnet USDC address and x402 setup, the self-host env vars). **4** was honest and useful even though
the capability is missing.

## Gaps, evidence and suggested fixes

**1. The docs don't know ai.pharos.xyz — and the agent times out instead of saying so.**
Query 0 never returned (≈180 s, then "Something went wrong"), on two different accounts. A direct call to the Docs
MCP endpoint (`docs.pharos.xyz/~gitbook/mcp`, `askQuestion` "What is ai.pharos.xyz and what can I do there?")
answers that the docs only describe Anvita Flow at `flow.anvita.xyz` "so I can't confirm that exact domain's
purpose" ([log/direct-docs-mcp.txt](log/direct-docs-mcp.txt)). The site itself has the same kind of drift: its
llms.txt page shows `https://www.pharos.xyz/agent-center/llms.txt`, which returns **404**
(`docs.pharos.xyz/llms.txt` → 200).
*Fix:* add an "ai.pharos.xyz" page — what the hub is, the agents (`@Pharos Docs MCP`, `@Pharos MCP`,
`@pharos-skill-engine`), the Guardian agent and credits, and how it relates to Anvita Flow; make the chat agent fail
fast with "not in the docs" instead of a timeout; fix the llms.txt URL.

**2. "get_logs does not include the block timestamp" is wrong.**
Live Pharos MCP `get_logs` returns `blockTimestamp` on every log (`npm run verify`: 25/25 logs). Following the
docs costs an extra `get_block` call per block — against a 120 req/min limit.
*Fix:* the Pharos MCP page should show a real `get_logs` result with `blockTimestamp`, and the JSON-RPC
`eth_getLogs` example should list the field (the docs show it only in a receipt example).

**3. No registry of ecosystem contracts.**
There is no list of DEX factories, routers or launchpads (FaroSwap, Prosper, …), so an indexer has to find them by
hand. I had to recover the Prosper factory and its `MarketCreated`/`Bought`/`Sold` event signatures myself
(task 02).
*Fix:* an "Ecosystem contracts" page next to Canonical Contracts: protocol, contract, address, verified ABI link,
key event topics.

**4. No way to publish an existing MCP server to other agents.**
Anvita Flow only accepts a zipped Skill; a working remote MCP endpoint can't be listed, and the developer console is
allowlisted ("contact the Pharos team").
*Fix:* document the "Skill as a thin wrapper over your MCP server" pattern with a minimal `SKILL.md` example, and
how to request console access — or allow registering a remote MCP URL as a Service Agent.

**5. Answers mix in providers the docs don't list.**
Answer 6 recommends "Alchemy, **QuickNode**, ZAN"; the RPC page lists only **ZAN, Nirvana and Alchemy**
(`npm run verify`). A docs agent should not introduce providers that aren't documented for Pharos.
*Fix:* ground provider lists strictly in the RPC Infrastructure page (and mention Nirvana's dev key, which is the
documented "more than 120/min" path).

**6. The `eth_getLogs` range limit is documented twice, differently.**
A direct Docs MCP query ("What is the maximum block range for eth_getLogs on the Pharos RPC?") answers "100 blocks
with rate limiting, 10,000 fallback" (JSON-RPC page) and "1,000" for MCP; the chat agent in answer 6 calls 1,000
"an upstream RPC limit". Live `rpc.pharos.xyz`: 101 blocks → ok, 1,001 blocks → *"narrowing it down to within
1,000 blocks"*.
*Fix:* one number — 1,000 — on the JSON-RPC page.

## What I built and ran by the end

Following answers 1, 3 and 6 (and correcting 2), the monitor from task 02 is live:

- **CLI monitor** ([`02-event-log-monitor`](../02-event-log-monitor)) — `get_logs` over curve markets with the
  Bought/Sold topics, 1,000-block windows, `blockTimestamp` taken straight from the logs (no `get_block` calls).
- **Hosted feed + own MCP server** ([`services/prosper-monitor`](../services/prosper-monitor)) —
  https://mcp.pharosfdv.xyz/prosper-monitor and `…/prosper-monitor/mcp`, indexing every Prosper curve 24/7 within
  the public 120 req/min.
- Next step from answer 4: wrap that MCP server in a Skill to list it on Anvita Flow (needs console access).

## Run the checks

From the repository root: `npm install && npm run build`, then:

```bash
npm run verify --workspace 03-docs-mcp-onboarding
```

```text
✓ Pharos MCP get_logs: 25/25 logs carry blockTimestamp (docs: "get_logs does not include the block timestamp")
  rpc.pharos.xyz eth_getLogs over 101 blocks: ok (7 logs)
  rpc.pharos.xyz eth_getLogs over 1001 blocks: rejected — param error; The block range is too large. Consider narrowing it down to within 1,000 blocks.
✓ llms.txt: www.pharos.xyz/agent-center/llms.txt → 404, docs.pharos.xyz/llms.txt → 200
✓ docs RPC providers: ZAN RPC, Nirvana RPC, Alchemy RPC — QuickNode is not among them
```

## Requirements checklist

- [x] Step-by-step log of what I tried, the exact questions asked to Docs MCP and the answers (table + [`log/`](log))
- [x] At least 3 concrete gaps, each with the exact query (6 gaps above)
- [x] A suggested fix for each gap
- [x] Ends with what I built/ran (live monitor + hosted MCP server)
