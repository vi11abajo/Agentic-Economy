#!/usr/bin/env bash
# Live rtfm run for the walkthrough video: turn on-chain checks on once, then five questions typed like a person
# (no quotes), one screen each. Uses its own settings file, so your real rtfm setting isn't touched.
# Usage (from this folder): bash demo.sh     ONLY=2 bash demo.sh runs just one scene
set -uo pipefail
cd "$(dirname "$0")/.."

EVENTS="${EVENTS_LOG:-/dev/null}"
export RTFM_CONFIG="demo/.rec/config.json"   # relative, so no local path shows up on screen
export RTFM_PROGRESS=1   # mintty doesn't look like a terminal to node, show the waiting line anyway
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'; MUTED=$'\e[38;2;107;107;107m'
ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
type_cmd() {
  local s="$1" i
  printf '%s%s$%s ' "$COBALT" "$BOLD" "$RESET"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "0.0$((RANDOM % 6 + 2))"; done
  printf '\n'
}
rtfm() { node dist/cli.js "$@" --color; }

QUESTIONS=(
  "I want gasless onboarding with ERC-4337 smart accounts on Pharos mainnet. Which EntryPoint should my bundler target?"
  "How many blocks can a single eth_getLogs call span on the public Pharos RPC before it gets rejected?"
  "My agent wants to charge 1 cent per call with x402 on Pharos mainnet. Which asset address goes into the payment requirements?"
  "Does Pharos mainnet support EIP-7702, so an EOA can delegate to a smart account code?"
  "What is the airspeed velocity of an unladen swallow?"
)

rm -rf demo/.rec && mkdir -p demo/.rec
clear
sleep "${START_DELAY:-2}"
ev start

# A single-scene run still needs the setting on.
[[ -n "${ONLY:-}" && "${ONLY}" != "0" ]] && rtfm --verify-on > /dev/null
if [[ -z "${ONLY:-}" || "${ONLY}" == "0" ]]; then
  ev "type s0"
  type_cmd "rtfm --verify-on"
  ev "sent s0"
  rtfm --verify-on
  ev "done s0"
  sleep 2.5
fi

for i in "${!QUESTIONS[@]}"; do
  n=$((i + 1))
  if [[ -n "${ONLY:-}" && "$n" != "$ONLY" ]]; then continue; fi
  clear
  q="${QUESTIONS[$i]}"
  ev "type s$n"
  type_cmd "rtfm $q"
  ev "sent s$n"
  rtfm "$q"
  code=$?
  printf '\n%s(exit code %s)%s\n' "$MUTED" "$code" "$RESET"
  ev "done s$n"
  sleep 4
done
ev end
sleep "${END_DELAY:-2}"
