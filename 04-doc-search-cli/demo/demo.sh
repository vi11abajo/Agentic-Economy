#!/usr/bin/env bash
# Live rtfm run for the walkthrough video: four questions typed like a person, one screen each.
# Usage (from this folder): bash demo.sh     ONLY=2 bash demo.sh runs just the second one
set -uo pipefail
cd "$(dirname "$0")/.."

EVENTS="${EVENTS_LOG:-/dev/null}"
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
type_cmd() {
  local s="$1" i
  printf '%s%s$%s ' "$COBALT" "$BOLD" "$RESET"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "0.0$((RANDOM % 6 + 2))"; done
  printf '\n'
}

QUESTIONS=(
  "I want gasless onboarding with ERC-4337 smart accounts on Pharos mainnet. Which EntryPoint should my bundler target?"
  "How many blocks can a single eth_getLogs call span on the public Pharos RPC before it gets rejected?"
  "My agent wants to charge 1 cent per call with x402 on Pharos mainnet. Which asset address goes into the payment requirements?"
  "Does Pharos mainnet support EIP-7702, so an EOA can delegate to a smart account code?"
)

clear
sleep "${START_DELAY:-2}"
ev start
for i in "${!QUESTIONS[@]}"; do
  n=$((i + 1))
  if [[ -n "${ONLY:-}" && "$n" != "$ONLY" ]]; then continue; fi
  clear
  q="${QUESTIONS[$i]}"
  ev "type q0$n"
  type_cmd "rtfm \"$q\" --verify"
  ev "sent q0$n"
  node dist/cli.js "$q" --verify --color 2>&1
  code=$?
  printf '\n%s(exit code %s)%s\n' $'\e[38;2;107;107;107m' "$code" "$RESET"
  ev "done q0$n"
  sleep 4
done
ev end
sleep "${END_DELAY:-2}"
