#!/usr/bin/env bash
# Live monitor run for the walkthrough video: watches the pMusk curve only, from the current block, and stops
# after MAX_EVENTS new trades (a buy and a sell made during the recording). Everything shown is the real run.
# Usage (from this folder): bash demo.sh        Stop early: touch .rec/STOP
set -uo pipefail
cd "$(dirname "$0")"

EVENTS="${EVENTS_LOG:-/dev/null}"
REC=.rec
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
type_cmd() {
  local s="$1" i
  printf '%s%s$%s ' "$COBALT" "$BOLD" "$RESET"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep 0.05; done
  printf '\n'
}

rm -rf "$REC" && mkdir -p "$REC"
: > "$REC/trades.jsonl"
clear
sleep "${START_DELAY:-2}"
ev start
ev "type start"
type_cmd "npm start"
ev "sent start"

node ../dist/index.js watch --config markets-demo.json --state "$REC/state.json" --log "$REC/trades.jsonl" \
  --color --max-events "${MAX_EVENTS:-2}" 2>> "$REC/stderr.log" &
pid=$!

# Mark each reported trade in the event log (used to cut the video) and honour the STOP file.
(
  seen=0
  while kill -0 "$pid" 2>/dev/null; do
    n=$(wc -l < "$REC/trades.jsonl")
    while ((seen < n)); do seen=$((seen + 1)); ev "trade $seen"; done
    [[ -f "$REC/STOP" ]] && kill -INT "$pid" 2>/dev/null
    sleep 0.2
  done
) &
wait "$pid"
sleep 0.5
ev "done start"
ev end
sleep "${END_DELAY:-2}"
