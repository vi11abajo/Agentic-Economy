# 23 · Recurring Payment Agent

**bookkeeper** is an agent skill that runs recurring payments on Pharos mainnet: payroll, rent, subscriptions. You
tell the agent in plain words ("pay my three people 50 USDC every Friday, and the subscription once a month,
starting today"). It asks for what you left out, always including when the first payment should go out. Then it
shows you one plan and waits for a yes. After that the bookkeeper pays from its own wallet on its own, every period,
until the money runs out or you stop the series. Every payout is reported to your Telegram bot and Discord channel:
who got paid, how much, when, and a link to the tx.

The part we cared about most is requirement 3: never paying twice. The other builds of this task we read keep a
ledger of what was paid and trust it. One of them says plainly that application-level dedup "cannot guarantee
on-chain exactly-once". bookkeeper keeps a journal too, but for USDC the guarantee comes from the token itself:

- Every USDC payment is a `transferWithAuthorization` (EIP-3009). The bookkeeper signs it with its own key and sends
  it itself.
- The authorization nonce is `keccak256("bookkeeper/v1", wallet, series, plan, period, payee)`. The USDC contract
  refuses a nonce it has already seen. A second payment of the same period to the same person fails on chain, even
  after a crash, two runs at once, or a second machine with the same key.
- The authorization is valid only inside its period: `validAfter` = due time - 1 s and `validBefore` = next due
  time. The token refuses a payment that is early ("authorization is not yet valid") and one whose period is over
  ("authorization is expired"). We checked both on mainnet with `eth_call`: [proof/01-window-check.txt](proof/01-window-check.txt).

## Quick start

```bash
cd 23-bookkeeper && npm ci && npm run build && npm test
node skill/bookkeeper/scripts/bookkeeper.mjs init            # .env with empty lines + launcher; prints the path
node skill/bookkeeper/scripts/bookkeeper.mjs settings        # which lines are filled (never the values)
node skill/bookkeeper/scripts/bookkeeper.mjs notify-test     # test message to Telegram/Discord
node skill/bookkeeper/scripts/bookkeeper.mjs draft plan.json # open questions, or the plan with its id
node skill/bookkeeper/scripts/bookkeeper.mjs approve <id>    # your yes: series on, OS scheduler entries written
node skill/bookkeeper/scripts/bookkeeper.mjs status          # history, counts, next payment, how long the money lasts
node skill/bookkeeper/scripts/bookkeeper.mjs log --json      # the journal, for the agent to explain
node skill/bookkeeper/scripts/bookkeeper.mjs stop <series>
```

The skill is `skill/bookkeeper/`: SKILL.md plus one bundled script. Nothing to install on the user's side but node.
The data folder is `%APPDATA%\bookkeeper` (or `~/.config/bookkeeper`). It holds the `.env` (wallet key, bot token,
webhook, filled by the user and never read by the agent), `series.json`, `people.json` (the address book, so "pay
Pete" works next time) and `journal.jsonl`.

## How a conversation goes

1. The agent writes what it understood into a draft (label, token, payees, period, first payment, timezone) and
   leaves out anything you didn't say. `draft` answers with one plain question per gap: "How much should Pete get
   each time?", "When should the first payment go out (date and time)?". The agent asks them one at a time.
2. When nothing is missing, `draft` prints the plan: who gets how much of which token, the period in words ("every
   week on Friday at 09:00 (Europe/Moscow)"), the first three payment times, and how often it checks. The agent
   retells it and waits for an explicit yes. Only then does it run `approve`.
3. From then on the OS scheduler starts `bookkeeper run`. Nothing of ours stays running.

## When it wakes up

How often it checks follows one rule: one unit below the period. Faster than hourly, the agent proposes an interval
and agrees it with you. On top of that there is one exact wake at the next payment moment, re-armed after every run,
so a payment is never late because of the check interval.

| Payment period | Regular check |
|---|---|
| month(s) | once a week |
| week(s), e.g. every 3 weeks | once a day |
| day(s) | once an hour |
| hour(s), e.g. every 3 hours | once an hour |
| faster than hourly | agreed with the user (the demo: every minute) |

On Windows both wakes are Task Scheduler tasks created from XML. XML uses ISO dates, so the tasks come out the same
on any Windows language. `StartWhenAvailable` runs a wake that fell while the PC was off as soon as it is back. On
Linux it uses crontab lines tagged `# bookkeeper`.

## Requirements → where they are met

| # | Requirement | How |
|---|---|---|
| 1 | Schedule (weekly or monthly) with amount, token and recipient | `draft`/`approve`: minute/hour/day/week/month × N, several payees, USDC or PROS, IANA timezone. Wall-clock aware: payday stays 09:00 across a DST change, and a series from the 31st pays on Feb 28 and then on Mar 31. [src/period.ts](src/period.ts), [src/plan.ts](src/plan.ts) |
| 2 | Prepares each payment on time, tracks paid / pending / failed | the exact wake + the regular check; each payment goes `due → signed → sent → paid`, or `short`, `failed` (retried), `missed`, all in `journal.jsonl`. [src/run.ts](src/run.ts) |
| 3 | Insufficient balance or failed tx without double-paying | short balance: nothing is sent, you get one message, and it is paid once on the first wake after a top-up. USDC: the token refuses a second payment of the period (nonce) or one outside the period (window). The signed tx is written down before broadcast; an unclear answer from the node is checked again, never rebuilt. A period that ended unpaid is `missed` and never paid late on its own. |
| 4 | Payment history and next scheduled payment | `status` (history per payment with explorer links, counts, next payment, how many more periods the wallet covers) and the Telegram/Discord cards |

## Proof

A live run on Pharos mainnet on 2026-11-10. The plan: three people, 0.001 USDC each, every 5 minutes, from 17:44
Europe/Paris, checked every minute (the interval agreed for a faster-than-hourly series). The paying wallet is
`0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb`. After `approve` nobody touched it: Windows Task Scheduler started
`bookkeeper run` every minute, plus once at each due time.

| Payment | Employee 1 | Employee 2 | Employee 3 |
|---|---|---|---|
| #1, 17:44 | [0x700555…da5b](https://www.pharosscan.xyz/tx/0x700555689b265cc5dfdec87dc64afe2c2f1e083d9eafd88c930ddeb49fb8da5b) | [0xa8af44…2375](https://www.pharosscan.xyz/tx/0xa8af4483e4f1589ece83a33d618ce795fd74390023b007952265d57630d42375) | [0x7d786d…865a](https://www.pharosscan.xyz/tx/0x7d786d2e3d62cfeca21eb6addc6e4d5b045a529bbff37d6e31832172b0ec865a) |
| #2, 17:49 | [0x4dba8a…a0d](https://www.pharosscan.xyz/tx/0x4dba8abdc391c27b510556dd9b1572c60facaea51abff57cd36186b1f53efa0d) | [0x8955ca…e93d](https://www.pharosscan.xyz/tx/0x8955ca5fc2580f65ff2419d0b2a926caf6d42ade31a5d70ec6b1610ce014e93d) | [0x282a28…9e30](https://www.pharosscan.xyz/tx/0x282a289f98b19f2943772f63c943d979e139082d549b930772107641a62d9e30) |

All six are `transferWithAuthorization` calls from the bookkeeper's wallet, all succeeded. Each one carries the
window of its own period (17:43:59 to 17:49:00 for #1, 17:48:59 to 17:54:00 for #2). The payments went out 5 to 15
seconds after the due time.

What the run shows:

- **A lost answer did not become a second payment.** In period #2 the node answered `RPC Request failed` while the
  bookkeeper waited for Employee 2's receipt. The tx was already signed and written down (`signed` → `sent`), so the
  run noted "could not finish this time" and stopped there. The next wake, a minute later, found the same tx
  `0x8955ca…e93d` in block 22671378 and marked it `paid`. Nothing new was signed. On chain the six payments use
  wallet nonces 570–575 with no gap and nothing after them, and USDC reports the authorization nonce of that payment
  as used. A second send of the same period would have failed in the token.
- **Re-runs pay nothing.** Between due times the scheduler woke the bookkeeper every minute. Each of those wakes
  logged `paid 0`.
- **History and next payment.** `status` lists every payment with its explorer link and the counts (paid 6). The
  Discord cards name the people, amounts, short addresses and tx links, and the next payment time. The wallet card
  says how many more periods the balance covers.
- **Stop.** We ended the demo before period #3: `schedule remove` took both scheduler tasks down at 17:53, and the
  user stopped the series at 18:02 with `stop`.

Files:

- [proof/02-live-status.txt](proof/02-live-status.txt): `bookkeeper status` after the run
- [proof/03-live-journal.txt](proof/03-live-journal.txt): `bookkeeper log`, the journal the agent explains (`due → signed → sent → paid` for each payment)
- [proof/04-live-run-log.txt](proof/04-live-run-log.txt): every scheduler wake, including the RPC failure and the recovery
- [proof/05-live-onchain-check.txt](proof/05-live-onchain-check.txt): receipts, decoded arguments and windows, the authorization nonce state, wallet nonces
- [proof/01-window-check.txt](proof/01-window-check.txt): `eth_call` showing USDC refusing an early and a late authorization

We did not let the run go until the wallet was short. The short-balance path (one message, nothing sent, paid once
after a top-up) is covered by the tests below.

## Limits

- PROS payments have no contract nonce. Their guard is the journal: the signed bytes are written before sending and
  re-sent, never rebuilt. If another tx takes the wallet's nonce, the payment is flagged for the user and not retried
  on its own.
- The bookkeeper's key sits in a file on the machine that pays. Keep only what the next payouts need in that wallet.
- The runway forecast assumes 100,000 gas per payment.

## Tests

`npm test`: 66 tests on a small in-memory Pharos (`src/fake.ts`) that applies the same EIP-3009 rules as USDC. They
cover: schedule maths, the questions the draft asks, one payment per period after a re-run, a crash after broadcast,
short balance over many wakes, missed windows, a stopped series, a node that refuses or loses a tx, a lagging node
and a failing RPC for PROS, a payee that fails at estimate, a stale or half-written lock, Telegram being down, and the
card texts.
