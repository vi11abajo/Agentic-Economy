# Agentic Economy: Pharos Season of AI builds

[![CI](https://github.com/vi11abajo/Agentic-Economy/actions/workflows/ci.yml/badge.svg)](https://github.com/vi11abajo/Agentic-Economy/actions/workflows/ci.yml)

My builds for the [Pharos Agent Arena](https://pharos-agent-arena.vercel.app/#tasks) tasks, made with the tools
from [ai.pharos.xyz](https://ai.pharos.xyz): Pharos Chain MCP, Developer Docs MCP and SkillEngine.

One folder per task. Everything is TypeScript (Node 20+) with one shared install (npm workspaces).

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

**2. Run a task.** Each task folder has its own Quick start with the exact commands. The short version, from
the `Agentic-Economy` folder:

```bash
npm start --workspace 01-read-contract-state
```

```bash
npm start --workspace 02-event-log-monitor
```

```bash
npm run verify --workspace 03-docs-mcp-onboarding
```

```bash
cd 04-doc-search-cli && npx --no-install rtfm "how do I verify a contract on Pharos?"
```

**Tests** (offline, on recorded Pharos MCP data, the same ones CI runs on every push):

```bash
npm test
```

**No Node on the machine?** Run everything in Docker instead, for example task 04:

```bash
docker run --rm -it node:22 bash -c "git clone -q https://github.com/vi11abajo/Agentic-Economy.git && cd Agentic-Economy && npm ci --silent && npm run build --silent && cd 04-doc-search-cli && npx --no-install rtfm 'Does Pharos mainnet support EIP-7702?' --verify"
```

## Tasks

| # | Task | Track | Tier | Folder |
|---|------|-------|------|--------|
| 01 | Read Contract State | Chain MCP | Easy | [`01-read-contract-state`](01-read-contract-state) |
| 02 | Event/Log Monitor: Prosper curve buys and sells | Chain MCP | Easy | [`02-event-log-monitor`](02-event-log-monitor) |
| 03 | Docs MCP Onboarding: ai.pharos.xyz through the Docs MCP agent | Developer Docs MCP | Easy | [`03-docs-mcp-onboarding`](03-docs-mcp-onboarding) |
| 04 | Doc-Search CLI: `rtfm`, sourced answers checked on-chain | Developer Docs MCP | Easy | [`04-doc-search-cli`](04-doc-search-cli) |
| 05 | Threshold Guardian: `trenchscope`, on-chain buy and sell checks for Prosper curve tokens | SkillEngine | Medium | [`05-trenchscope`](05-trenchscope) |

## Shared code

- [`packages/pharos-mcp`](packages/pharos-mcp): a small client for the hosted Pharos Chain MCP server
  (`https://mcp.pharos.xyz/mcp`). It parses JSON tool results, paces requests to stay under the limit of
  120 per minute per IP, and retries on HTTP 429 or when a block hasn't reached every RPC node yet.
- [`services/prosper-monitor`](services/prosper-monitor): the hosted Prosper monitor from task 02 (live feed,
  Telegram alerts and its own MCP server).
