#!/usr/bin/env bash
# Ask a Claude Code agent the questions in prompts/ as ONE conversation. The agent's only tools are the
# Pharos Chain MCP tools connected in .mcp.json; every turn's full transcript is saved to transcripts/.
#
# Requires the Claude Code CLI (`claude`), signed in. Usage: bash run-agent.sh
set -euo pipefail
cd "$(dirname "$0")"
# Raw output contains details of the local machine (paths, plugins, hooks); it stays in transcripts/raw
# (git-ignored) and only the sanitized copy in transcripts/ is published.
mkdir -p transcripts/raw

# Only the Pharos MCP server is loaded and allowed; local file, shell and web tools are switched off,
# so every fact in an answer has to come from a Pharos Chain MCP tool call.
DISALLOWED="Bash Read Write Edit Glob Grep NotebookEdit WebFetch WebSearch Task Agent TodoWrite Skill"

session=""
for prompt_file in prompts/*.txt; do
  name="$(basename "$prompt_file" .txt)"
  args=(
    -p "$(cat "$prompt_file")"
    --mcp-config .mcp.json --strict-mcp-config
    --allowedTools mcp__pharos
    --disallowedTools $DISALLOWED
    --output-format stream-json --verbose
  )
  if [[ -n "$session" ]]; then args+=(--resume "$session"); fi
  echo "-> $name" >&2
  claude "${args[@]}" > "transcripts/raw/$name.jsonl"
  session="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    const result = lines.map((l) => JSON.parse(l)).reverse().find((e) => e.type === "result");
    process.stdout.write(result?.session_id ?? "");
  ' "transcripts/raw/$name.jsonl")"
done

node sanitize-transcripts.mjs transcripts/raw transcripts
node render-transcript.mjs transcripts > TRANSCRIPT.md
echo "Transcript written to TRANSCRIPT.md" >&2
