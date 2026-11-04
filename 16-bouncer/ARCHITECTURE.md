# bouncer: architecture

```
request --> unsigned tx --> debug_traceCall on mainnet --> facts --> 7 rules --> ALLOW / DENY + rule --> audit.jsonl
                                                                                    |
                                                          send, ALLOW only: sign that exact tx --> receipt --> audit.jsonl
```

| File | Job |
|---|---|
| `src/request.ts` | turns `pros` / `token` / `approve` / `call` / `raw` / `--tx` into the one exact unsigned tx that gets judged |
| `src/chain.ts` | the only door to the chain: JSON-RPC (trace, gas, code, balance, send), a nap on the public node's rate limit, tapes for tests |
| `src/trace.ts` | reads a callTracer trace into facts: contracts touched with depth and path, PROS and tokens leaving the wallet, receivers, approvals, revert reason |
| `src/policy.ts` | the policy file, parsed strictly (every problem listed, nothing guessed) |
| `src/rules.ts` | the seven rules and `judge()`, which stops at the first "no" |
| `src/gate.ts` | one decision: policy, clock, then everything read at one block, judged and logged |
| `src/audit.ts` | the hash-chained log, the lock around writes, and what was spent in the last 24 hours |
| `src/send.ts` | the only path to the key: a fresh gate, then sign, log the hash, broadcast, log the receipt |
| `src/report.ts` | how a verdict reads, for people and as JSON |
| `src/cli.ts` | commands, policy editing, exit codes |
| `src/store.ts` | the data folder and the key in `.env` |

## Decisions worth knowing

- **One block for everything.** Trace, gas estimate, balance and `eth_getCode` all read block head - 1, so they
  describe the same moment.
- **Clock first, no network.** Outside the time window the chain isn't asked anything.
- **DELEGATECALL frames.** On Pharos they show the proxy itself as `to` and repeat the parent's value. They are
  not hops and their value isn't counted.
- **Reverted inner frames.** Their contracts are still checked (stricter), their transfers aren't counted (they
  were rolled back).
- **Gas is not spending.** Caps limit what leaves the wallet to others; `simulation` makes sure value + gas
  limit x max fee fits the balance.
- **Daily spend comes only from the log.** Receipt amounts when mined, nothing for a revert, the traced amount
  while no receipt is known. A broken log means "unknown", and unknown is a deny.
- **send re-judges.** The decision that counts is the one made right before signing, with the policy as it is
  then; its hash goes in the log.
