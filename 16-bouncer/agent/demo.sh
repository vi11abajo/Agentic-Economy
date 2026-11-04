#!/usr/bin/env bash
# Live chat with a Claude Code agent for the walkthrough video. Turn 1 asks the agent to install the bouncer
# skill from GitHub by itself; turn 2 sets the wallet's rules in plain words. Then real requests on Pharos
# mainnet: a pMusk buy that bouncer stops because the trace reaches contracts nobody listed, the same buy sent
# for real once they're added, a second real buy, then one deny for every other rule (daily cap, per-tx cap,
# recipients, approvals, simulation, time window) and a check that nobody edited the log.
# Messages are typed like a person types (uneven speed, short pauses); links and addresses are pasted.
# Everything on screen is the real run; local paths are redacted, stderr stays off screen.
# Usage: DEMO_DIR=/some/empty/folder BOUNCER_HOME=/folder/with/.env bash demo.sh   (ONLY=02 for one turn)
# DEMO_DIR must be outside any git repo, so the agent sees nothing but its own empty workspace.
# BOUNCER_HOME is bouncer's data folder; its .env holds the test wallet's key, written there by the user.
# A full run starts from no policy and an empty log: the old ones are moved to BOUNCER_HOME/before-<time>/.
set -uo pipefail
cd "$(dirname "$0")"

EVENTS="${EVENTS_LOG:-/dev/null}"
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
DEMO_DIR="${DEMO_DIR:?set DEMO_DIR to an empty folder outside any git repo}"
export BOUNCER_HOME="${BOUNCER_HOME:?set BOUNCER_HOME to the data folder whose .env holds the test wallet key}"
# Where the agent works: an empty folder, so it decides on its own how and where to install the skill.
WORK="$DEMO_DIR/workspace"
export DISABLE_TELEMETRY=1 npm_config_fund=false npm_config_update_notifier=false npm_config_audit=false
export npm_config_cache="${npm_config_cache:-$PWD/../../../.npm-cache}"   # keep npx downloads next to the project
STYLE="This is a live chat shown in a terminal. Keep replies short, in plain text: no headings, no bold, no tables of your own. Answer in plain words; do not paste bouncer's whole output, only quote a line from it when it helps. The user's wallet is the one bouncer setup reports. Install skills with the skills CLI, for this project only: npx skills add <url> -a claude-code -y --copy (never -g). Writing into .claude by hand needs an approval nobody can give here."
ALLOWED=(Skill Read WebFetch Bash)   # the agent only ever runs inside the empty workspace folder
DENIED=(PowerShell Write Edit NotebookEdit Task Agent TodoWrite WebSearch)

ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
pause() { sleep "$(awk -v a="$1" -v b="$2" -v r="$RANDOM" 'BEGIN { printf "%.3f", a + (b - a) * r / 32767 }')"; }
say() {  # type like a person; {{...}} is pasted in one go after a short pause
  local s="$1" ch
  printf '%s%sYou ›%s ' "$COBALT" "$BOLD" "$RESET"
  pause 0.6 1.0
  while [[ -n "$s" ]]; do
    if [[ "$s" == "{{"* ]]; then
      local paste="${s#\{\{}"
      paste="${paste%%\}\}*}"
      s="${s#*\}\}}"
      pause 1.6 2.2
      printf '%s' "$paste"
      pause 0.5 0.9
      continue
    fi
    ch="${s:0:1}"
    s="${s:1}"
    printf '%s' "$ch"
    if [[ "$ch" == " " ]] && (( RANDOM % 100 < 25 )); then pause 0.12 0.3
    elif (( RANDOM % 100 < 3 )); then pause 0.45 0.9
    else pause 0.035 0.13
    fi
  done
  pause 0.4 0.8
  printf '\n'
}

if [[ -z "${ONLY:-}" ]]; then
  rm -rf "$WORK" "$DEMO_DIR/session"
  mkdir -p "$WORK"
  # A fresh take starts with no rules and no history (a retake within 24 h would hit the daily cap early).
  old=()
  for f in policy.json audit.jsonl; do [[ -f "$BOUNCER_HOME/$f" ]] && old+=("$f"); done
  if (( ${#old[@]} )); then
    keep="$BOUNCER_HOME/before-$(date +%Y%m%d-%H%M%S)"
    mkdir -p "$keep"
    for f in "${old[@]}"; do mv "$BOUNCER_HOME/$f" "$keep/"; done
  fi
fi
mkdir -p transcripts/raw
clear
sleep "${START_DELAY:-2}"
ev start

session="$(cat "$DEMO_DIR/session" 2>/dev/null || true)"
for prompt_file in prompts/*.txt; do
  name="$(basename "$prompt_file" .txt)"
  if [[ -n "${ONLY:-}" && "$name" != "${ONLY}"* ]]; then continue; fi
  if [[ -n "${STOP_AFTER:-}" && "$name" > "${STOP_AFTER}~" ]]; then break; fi   # free dry run: only the first turns
  prompt="$(cat "$prompt_file")"
  [[ "$name" != 01-* ]] && echo
  if [[ -f "prompts/$name.pause" && -z "${ONLY:-}" ]]; then  # the user is away for a while before this turn
    ev "pause $name"
    sleep "$(cat "prompts/$name.pause")"
  fi
  ev "type $name"
  say "$prompt"
  ev "sent $name"
  plain_prompt="$(printf '%s' "$prompt" | sed 's/{{//g; s/}}//g')"
  args=(-p "$plain_prompt" --allowedTools "${ALLOWED[@]}" --disallowedTools "${DENIED[@]}" --append-system-prompt "$STYLE"
        --output-format stream-json --verbose)
  if [[ -n "$session" ]]; then args+=(--resume "$session"); fi
  (cd "$WORK" && claude "${args[@]}" 2>> "$OLDPWD/transcripts/raw/stderr.log") | node pretty-stream.mjs "transcripts/raw/$name.jsonl" "$EVENTS"
  ev "done $name"
  session="$(node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").trim().split("\n");
    const r = lines.map((l) => { try { return JSON.parse(l); } catch { return {}; } }).reverse().find((e) => e.type === "result");
    process.stdout.write(r?.session_id ?? "");
  ' "transcripts/raw/$name.jsonl")"
  printf '%s' "$session" > "$DEMO_DIR/session"
  sleep 1.5
done
ev end
sleep "${END_DELAY:-2}"
