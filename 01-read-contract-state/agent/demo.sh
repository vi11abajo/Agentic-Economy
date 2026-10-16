#!/usr/bin/env bash
# Live chat with a Claude Code agent (used for the walkthrough video). Turn 1 asks the agent to install
# Pharos Chain MCP itself; the next turns ask about a token using only the Pharos MCP tools.
# Everything shown is the real run; absolute local paths are redacted, stderr stays off screen.
# Usage: bash demo.sh   (ONLY=01 bash demo.sh for one turn)
set -uo pipefail
cd "$(dirname "$0")"

EVENTS="${EVENTS_LOG:-/dev/null}"
mkdir -p transcripts/raw
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
NO_LOCAL_TOOLS="Read Write Edit Glob Grep NotebookEdit WebFetch WebSearch Task Agent TodoWrite Skill"
STYLE="This is a live chat shown in a terminal: reply in plain text without Markdown, in at most 3 short sentences, and do not mention git or local files."

ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
say() {  # type the user's message like a person would
  local s="$1" i
  printf '%s%sYou ›%s ' "$COBALT" "$BOLD" "$RESET"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep 0.03; done
  printf '\n'
}

clear
sleep "${START_DELAY:-2}"
ev start
rm -f .mcp.json  # the agent installs it in turn 1

session=""
for prompt_file in prompts/*.txt; do
  name="$(basename "$prompt_file" .txt)"
  if [[ -n "${ONLY:-}" && "$name" != "${ONLY}"* ]]; then continue; fi
  prompt="$(cat "$prompt_file")"
  [[ -n "$session" ]] && echo
  ev "type $name"
  say "$prompt"
  ev "sent $name"
  if [[ "$name" == 01-* ]]; then
    # Turn 1: the agent may only run `claude mcp add` (project scope keeps the config in this folder).
    args=(-p "$prompt" --allowedTools "Bash(claude mcp add:*)" --disallowedTools PowerShell $NO_LOCAL_TOOLS
          --append-system-prompt "$STYLE Install MCP servers with project scope (-s project) so the config stays in this folder. A newly added server's tools load on the next turn, so don't try to verify it in this turn.")
  else
    args=(-p "$prompt" --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__pharos
          --disallowedTools Bash PowerShell $NO_LOCAL_TOOLS --append-system-prompt "$STYLE")
  fi
  args+=(--output-format stream-json --verbose)
  if [[ -n "$session" ]]; then args+=(--resume "$session"); fi
  claude "${args[@]}" 2>> transcripts/raw/stderr.log | node pretty-stream.mjs "transcripts/raw/$name.jsonl" "$EVENTS"
  ev "done $name"
  if [[ "$name" == 01-* && ! -f .mcp.json ]]; then ev "fail install"; ev end; exit 1; fi
  session="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    const r = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).reverse().find((e) => e.type === "result");
    process.stdout.write(r?.session_id ?? "");
  ' "transcripts/raw/$name.jsonl")"
  sleep 1.5
done
ev end
sleep "${END_DELAY:-2}"
