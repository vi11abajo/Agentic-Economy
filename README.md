# Agentic Economy — Pharos Season of AI builds

Builds for the [Pharos Agent Arena](https://pharos-agent-arena.vercel.app/#tasks) task board,
made with the tools of [ai.pharos.xyz](https://ai.pharos.xyz): Pharos Chain MCP, Developer Docs MCP and SkillEngine.

One folder per task. All code is TypeScript (Node 20+), one shared install via npm workspaces.

```bash
npm install
npm run build
```

## Tasks

| # | Task | Track | Tier | Folder |
|---|------|-------|------|--------|
| 01 | Read Contract State | Chain MCP | Easy | [`01-read-contract-state`](01-read-contract-state) |
| 02 | Event/Log Monitor — Prosper curve buys & sells | Chain MCP | Easy | [`02-event-log-monitor`](02-event-log-monitor) |
| 03 | Docs MCP Onboarding — ai.pharos.xyz via the Docs MCP agent, 6 docs gaps | Developer Docs MCP | Easy | [`03-docs-mcp-onboarding`](03-docs-mcp-onboarding) |

## Shared packages

- [`packages/pharos-mcp`](packages/pharos-mcp) — client for the hosted Pharos Chain MCP server
  (`https://mcp.pharos.xyz/mcp`): JSON tool results, request pacing under the 120 requests/minute/IP limit,
  retries on HTTP 429 and on blocks not yet available on every RPC node.
