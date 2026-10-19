#!/usr/bin/env bash
# Live rtfm session for the walkthrough video, one terminal from start to end: clone, install, build, then
# questions typed like a person. The first eth_getLogs question runs without checks, then --verify-on and the
# same question again, so you see what the check adds.
# Usage: WORK=/some/empty/dir bash demo.sh   (clones into $WORK; the rtfm setting lives inside that clone)
set -uo pipefail

EVENTS="${EVENTS_LOG:-/dev/null}"
WORK="${WORK:?set WORK to an empty folder}"
export RTFM_PROGRESS=1   # mintty doesn't look like a terminal to node, show the waiting line anyway
export npm_config_fund=false npm_config_update_notifier=false npm_config_audit=false
COBALT=$'\e[38;2;30;43;250m'; BOLD=$'\e[1m'; RESET=$'\e[0m'
ev() { echo "$(date +%s%3N) $1" >> "$EVENTS"; }
type_cmd() {
  local s="$1" i
  printf '%s%s$%s ' "$COBALT" "$BOLD" "$RESET"
  for ((i = 0; i < ${#s}; i++)); do printf '%s' "${s:i:1}"; sleep "0.0$((RANDOM % 6 + 2))"; done
  printf '\n'
}
step() { # step <name> <shown command> <real command...>
  local name="$1" shown="$2"
  shift 2
  ev "type $name"
  type_cmd "$shown"
  ev "sent $name"
  "$@"
  ev "done $name"
  echo
  sleep "${PAUSE:-2.5}"
}
rtfm() { node "$WORK/Agentic-Economy/04-doc-search-cli/dist/cli.js" "$@" --color; }

GETLOGS="How many blocks can a single eth_getLogs call span on the public Pharos RPC before it gets rejected?"
ENTRYPOINT="I want gasless onboarding with ERC-4337 smart accounts on Pharos mainnet. Which EntryPoint should my bundler target?"
X402="My agent wants to charge 1 cent per call with x402 on Pharos mainnet. Which asset address goes into the payment requirements?"
EIP7702="Does Pharos mainnet support EIP-7702, so an EOA can delegate to a smart account code?"
SWALLOW="What is the airspeed velocity of an unladen swallow?"

mkdir -p "$WORK" && cd "$WORK" || exit 1
clear
sleep "${START_DELAY:-2}"
ev start

step clone "git clone https://github.com/vi11abajo/Agentic-Economy.git" git clone https://github.com/vi11abajo/Agentic-Economy.git
cd Agentic-Economy || exit 1
step install "cd Agentic-Economy && npm ci" npm ci
step build "npm run build" npm run build --silent
cd 04-doc-search-cli || exit 1
export RTFM_CONFIG="demo/.rec/config.json"   # relative, so no local path shows up on screen
step alias 'cd 04-doc-search-cli && alias rtfm="node $PWD/dist/cli.js"' true

step ask-plain "rtfm $GETLOGS" rtfm "$GETLOGS"
step verify-on "rtfm --verify-on" rtfm --verify-on
step ask-checked "rtfm $GETLOGS" rtfm "$GETLOGS"
step entrypoint "rtfm $ENTRYPOINT" rtfm "$ENTRYPOINT"
step x402 "rtfm $X402" rtfm "$X402"
step eip7702 "rtfm $EIP7702" rtfm "$EIP7702"
step swallow "rtfm $SWALLOW" rtfm "$SWALLOW"

ev end
sleep "${END_DELAY:-2}"
