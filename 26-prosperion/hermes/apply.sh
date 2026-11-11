#!/usr/bin/env bash
# Puts the Prosperion settings on top of a stock Hermes config.
# Run as the prosperion user on the box. It never prints secrets.
set -euo pipefail
H="$HOME/.local/bin/hermes"

"$H" config set model.provider antigravity-subscription-directsdk
"$H" config set model.default gemini-3.8-flash

# The agent reads the chain and explains it. Everything that could touch the
# box, the web or its own memory is switched off, everywhere.
"$H" config set agent.disabled_toolsets '["terminal","file","code_execution","browser","delegation","cronjob","memory","kanban","catalog","skills","web","search","image_gen","video_gen","tts","vision","computer_use","connections","session_search","todo","x_search","context_engine","desktop_ui","project"]'

# Two agy workers at most: each turn is a separate process and the box is shared.
"$H" config set max_concurrent_sessions 2

# Read-only tools. send_raw_transaction is cut so the agent can never broadcast.
"$H" config set mcp_servers '{
  "pharos-chain": {"url": "https://mcp.pharos.xyz/mcp", "tools": {"exclude": ["send_raw_transaction"]}},
  "pharos-docs":  {"url": "https://docs.pharos.xyz/~gitbook/mcp"},
  "prosperion":   {"url": "http://127.0.0.1:18621/mcp"}
}'

# API server on loopback only. The key is made here once and stays in .env.
ENV="$("$H" config env-path)"
touch "$ENV"; chmod 600 "$ENV"
grep -q '^API_SERVER_ENABLED=' "$ENV" || echo 'API_SERVER_ENABLED=true' >> "$ENV"
grep -q '^API_SERVER_KEY=' "$ENV" || echo "API_SERVER_KEY=$(openssl rand -hex 32)" >> "$ENV"
echo "applied; api key present: $(grep -c '^API_SERVER_KEY=' "$ENV")"

# The agent's identity plus the Prosper codex, in one SOUL.md (the skills toolset is off, so it cannot edit them).
if [ -f "$HOME/prosperion/hermes/SOUL.md" ]; then
  { cat "$HOME/prosperion/hermes/SOUL.md"; echo; awk 'f>=2{print} /^---$/{f++}' "$HOME/prosperion/skill/prosperion/SKILL.md"; } > "$HOME/.hermes/SOUL.md"
  echo "SOUL.md written ($(wc -c < "$HOME/.hermes/SOUL.md") bytes)"
fi
