# 06 · Saga Executor (SkillEngine · Hard)

**trenchsaga** moves a Prosper bonding-curve bag on Pharos mainnet from one token to another as a saga. It's
the trench rotation: get out of token A, get into token B, and never end up stuck halfway.

| # | Step | Checked before the next step | Undo if a later step fails for good |
|---|---|---|---|
| 1 | approve A for the Prosper router | allowance on chain | put the allowance back |
| 2 | sell A on its curve for WPROS | `Sold` event in the receipt, WPROS balance | unwrap, buy A back |
| 3 | unwrap WPROS to PROS | WPROS balance | nothing: buying A back needs PROS |
| 4 | buy B on its curve | `Bought` event in the receipt, B balance | last step |

Work in progress: retries, rollback, journal and resume are done and unit-tested; live runs and the full
write-up come next.

## Tests

```bash
npm test -w 06-trenchsaga
```
