#!/usr/bin/env bash
# Ask a Claude Code agent the questions in prompts/ as ONE conversation (no terminal effects; see demo.sh
# for the live, typed version used in the video). Turn 1 asks the agent to install Pharos Chain MCP itself
# (it may only run `claude mcp add`); every later turn may only use the Pharos MCP tools.
# Requires the signed-in Claude Code CLI (`claude`). Usage: bash run-agent.sh
set -euo pipefail
cd "$(dirname "$0")"
# Raw output contains details of the local machine (paths, plugins, hooks); it stays in transcripts/raw
# (git-ignored) and only the sanitized copy in transcripts/ is published.
mkdir -p transcripts/raw

NO_LOCAL_TOOLS="Read Write Edit Glob Grep NotebookEdit WebFetch WebSearch Task Agent TodoWrite Skill"
STYLE="Reply in plain text without Markdown, in at most 3 short sentences, and do not mention git or local files."

rm -f .mcp.json  # the agent installs it in turn 1
session=""
for prompt_file in prompts/*.txt; do
  name="$(basename "$prompt_file" .txt)"
  prompt="$(cat "$prompt_file")"
  if [[ "$name" == 01-* ]]; then
    args=(-p "$prompt" --allowedTools "Bash(claude mcp add:*)" --disallowedTools PowerShell $NO_LOCAL_TOOLS
          --append-system-prompt "$STYLE Install MCP servers with project scope (-s project) so the config stays in this folder. A newly added server's tools load on the next turn, so don't try to verify it in this turn.")
  else
    args=(-p "$prompt" --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__pharos
          --disallowedTools Bash PowerShell $NO_LOCAL_TOOLS --append-system-prompt "$STYLE")
  fi
  args+=(--output-format stream-json --verbose)
  if [[ -n "$session" ]]; then args+=(--resume "$session"); fi
  echo "-> $name" >&2
  claude "${args[@]}" > "transcripts/raw/$name.jsonl" 2>> transcripts/raw/stderr.log
  if [[ "$name" == 01-* && ! -f .mcp.json ]]; then echo "Pharos MCP was not installed" >&2; exit 1; fi
  session="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n");
    const r = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).reverse().find((e) => e.type === "result");
    process.stdout.write(r?.session_id ?? "");
  ' "transcripts/raw/$name.jsonl")"
done

node sanitize-transcripts.mjs transcripts/raw transcripts
node render-transcript.mjs transcripts > TRANSCRIPT.md
echo "Transcript written to TRANSCRIPT.md" >&2
