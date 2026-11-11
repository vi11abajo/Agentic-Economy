#!/usr/bin/env bash
# Is the agent really alive and really reading the chain? Ask it for the latest Pharos block and compare
# with what the RPC says right after. Run on the box as root: bash smoke.sh
set -euo pipefail
KEY=$(grep -E '^API_SERVER_KEY=' /opt/prosperion/home/.hermes/.env | cut -d= -f2-)

started=$(date +%s.%N)
answer=$(curl -s -m 240 http://127.0.0.1:8642/v1/chat/completions \
  -H "Authorization: Bearer $KEY" -H 'content-type: application/json' \
  -d '{"model":"prosperion","messages":[{"role":"user","content":"What is the latest Pharos mainnet block number? Use a tool, then reply with the number only."}]}')
took=$(echo "$(date +%s.%N) - $started" | bc)

said=$(echo "$answer" | python3 -c 'import sys,json,re; t=json.load(sys.stdin)["choices"][0]["message"]["content"]; m=re.findall(r"\d[\d,]{5,}", t); print(m[-1].replace(",","") if m else "none")')
chain=$(curl -s -m 20 https://rpc.pharos.xyz -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' | python3 -c 'import sys,json; print(int(json.load(sys.stdin)["result"],16))')

echo "agent said: $said, chain now: $chain, answer took ${took}s"
if [ "$said" = "none" ]; then echo "FAIL: no number in the answer"; exit 1; fi
gap=$((chain - said))
# the agent read its block before we read ours, so it can only be behind; allow the answer time plus 5 blocks of slack
if [ "$gap" -ge 0 ] && [ "$gap" -le "$(printf '%.0f' "$(echo "$took + 5" | bc)")" ]; then echo PASS; else echo "FAIL: gap $gap blocks"; exit 1; fi
