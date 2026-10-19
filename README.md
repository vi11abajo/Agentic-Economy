# Agentic Economy: Pharos Season of AI builds

[![CI](https://github.com/vi11abajo/Agentic-Economy/actions/workflows/ci.yml/badge.svg)](https://github.com/vi11abajo/Agentic-Economy/actions/workflows/ci.yml)

My builds for the [Pharos Agent Arena](https://pharos-agent-arena.vercel.app/#tasks) tasks, made with the tools
from [ai.pharos.xyz](https://ai.pharos.xyz): Pharos Chain MCP, Developer Docs MCP and SkillEngine.

One folder per task. Everything is TypeScript (Node 20+) with one shared install (npm workspaces).

```bash
npm install
npm run build
npm test   # unit tests on recorded Pharos MCP data, no network; CI runs them on every push
```

## Tasks

| # | Task | Track | Tier | Folder |
|---|------|-------|------|--------|
| 01 | Read Contract State | Chain MCP | Easy | [`01-read-contract-state`](01-read-contract-state) |
| 02 | Event/Log Monitor: Prosper curve buys and sells | Chain MCP | Easy | [`02-event-log-monitor`](02-event-log-monitor) |
| 03 | Docs MCP Onboarding: ai.pharos.xyz through the Docs MCP agent | Developer Docs MCP | Easy | [`03-docs-mcp-onboarding`](03-docs-mcp-onboarding) |
| 04 | Doc-Search CLI: `rtfm`, sourced answers checked on-chain | Developer Docs MCP | Easy | [`04-doc-search-cli`](04-doc-search-cli) |

## Shared code

- [`packages/pharos-mcp`](packages/pharos-mcp): a small client for the hosted Pharos Chain MCP server
  (`https://mcp.pharos.xyz/mcp`). It parses JSON tool results, paces requests to stay under the limit of
  120 per minute per IP, and retries on HTTP 429 or when a block hasn't reached every RPC node yet.
- [`services/prosper-monitor`](services/prosper-monitor): the hosted Prosper monitor from task 02 (live feed,
  Telegram alerts and its own MCP server).
