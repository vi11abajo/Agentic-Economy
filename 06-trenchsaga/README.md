# 06 · Saga Executor (SkillEngine · Hard)

**trenchsaga** is an agent skill that moves a Prosper (pros-per.xyz) bonding-curve bag on Pharos mainnet from
one token to another as a saga. It's the trench rotation: get out of token A, get into token B, and never end
up stuck halfway with your money in some middle state.

## The saga

| # | Step | Checked on chain before the next step starts | Undo, if a later step fails for good |
|---|---|---|---|
| 1 | approve A for the Prosper router | the allowance | put the allowance back as it was |
| 2 | sell A on its curve, for WPROS | the `Sold` event in the receipt, and the WPROS balance grew by exactly that | unwrap what's left, buy A back |
| 3 | unwrap WPROS to PROS | the WPROS balance dropped by exactly that | nothing: buying A back needs PROS anyway |
| 4 | buy B on its curve with the PROS | the `Bought` event, and the B balance grew by exactly that | last step |

Every step builds its transaction from fresh state (a new quote, `minOut` within your slippage limit, a new
deadline), and checks its result by reading balances at the receipt's block and the block before it. I had
to do it that way: the public RPC is load balanced, and right after a receipt a read at "latest" can land on a
node that hasn't seen that block yet. My first version read "latest" and once saw a finished unwrap as
undone.

`trenchsaga enter <B> <PROS>` is the same machinery with just step 4, to get a first bag.

## Retry policy (transient failures)

A failure isn't judged by its error type. A revert can be caused by the state moving between signing and
inclusion (someone traded on the curve first, the deadline passed), and that goes away by itself. So after
every failed attempt the step is rebuilt on fresh state and simulated again:

- **the simulation passes**: it was transient, send again (up to `max_attempts`, 3 by default)
- **the simulation fails**: it's permanent, stop and roll back

On top of that:

- **Not mined in time** (`receipt_timeout_sec`, 30 s): the transaction is replaced with the same nonce and a
  higher fee and tip. All hashes sent for that nonce are checked on every round, so if the old one lands after
  all, it's used and the step is not done twice.
- **Refused by the node** (for example underpriced): sent again at a fair fee. I tried a 1 gwei transaction on
  mainnet (the base fee is a flat 10 gwei): `rpc.pharos.xyz` refuses it right away with "Invalid parameters
  were provided to the RPC method", it never sits in a mempool. Gas spikes don't really happen on Pharos, so a
  dropped or refused transaction is the realistic transient case.
- **Reading the chain fails** (the public RPC answers "Request too fast" under load): that says nothing about
  the step, so the saga waits and reads again, keeping what it already sent. My first version treated this as
  a failed step; that's the second bug the live runs found.
- Reverts are decoded: Prosper's custom errors (`Slippage()`, `DeadlineExpired()`, ...) were found in the
  router, market and pToken bytecode and in a real reverted buy, plus `Error(string)` and `Panic`.

## Rollback (permanent failures)

When a step can't succeed, the steps already done are undone in reverse order, each undo with the same retry
policy and its own receipt checks. Undos look at the wallet, not at what the saga remembers: "unwrap what's
left" unwraps whatever WPROS is really there, so running it twice is harmless. If an undo itself can't be
done, the saga stops as `stuck`, says which undo and why, and `resume` continues it later.

The curve takes a 1% fee each way, so buying A back returns a bit less A than was sold. Nothing is left in a
middle token, and the allowance is back to what it was.

## State log

- `saga.jsonl` in the data folder: one line per transition (start, sending with nonce and fee, sent, confirmed,
  verified, reverted with the reason, refused, not mined, compensating, compensated, ...).
- `sagas/<id>.json`: the saga's current state, rewritten after every transition (write to a temp file, then
  rename), with the hashes of anything sent and not yet settled.
- `trenchsaga status [id]` shows which step a saga is in, `trenchsaga log [id]` replays its journal, and
  `trenchsaga resume [id]` continues an interrupted saga: it checks the pending transactions first, so a crash
  between sending and the receipt doesn't send twice.

## Real runs on Pharos mainnet

All from a test wallet with 0.1 PROS, each buy capped at 0.01 PROS. Full logs in [`examples/`](examples).

**From the video**, asked in plain words to a Claude Code agent with the skill installed:

**1. "Try 1 gwei gas first": refused, retried, done** (pPeng → pMusk with `--start-fee 1`,
[`05-rotation-start-fee-refused-then-done.txt`](examples/05-rotation-start-fee-refused-then-done.txt)).
The node refused the 1 gwei approve at once, the saga resent it with the same nonce at 30 gwei and ran the
rest at the normal fee:

- approve [0x29dd…01f0](https://www.pharosscan.xyz/tx/0x29ddf351c79edb28c7e87b4957a7f3149fca768e3d9892db5b82287de30b01f0)
- sell 977 pPeng for 0.008864 WPROS [0x07f2…1271](https://www.pharosscan.xyz/tx/0x07f24706c754c1942abd79aedfed87eddb63e270f2760c3e3a8bb115c3821271)
- unwrap [0x094f…3a5f](https://www.pharosscan.xyz/tx/0x094f8f3e827f33ae3b6ba7c569d0a945bda9bb23b97b4247bb1918b77b4e3a5f)
- buy 1,143 pMusk [0xd578…9273](https://www.pharosscan.xyz/tx/0xd57845a0e7d30785a8e8d8f595632f8848d7191e0e1503814fcda8930f699273)

**2. "Only if I get at least 2,000": not met, rolled back** (pMusk → pPeng with `--min-out 2000`,
[`06-min-out-not-met-rolled-back.txt`](examples/06-min-out-not-met-rolled-back.txt)). The plan already warned
that the curve gave about 939 pPeng; the user said go anyway:

- approve [0x9a4d…dd4c](https://www.pharosscan.xyz/tx/0x9a4d8c606fd56d5bdcb722af17194638e4db6b58d394bcfa584f6833f454dd4c),
  sell 1,143 pMusk for 0.008687 WPROS [0xebb9…fb64](https://www.pharosscan.xyz/tx/0xebb9fad6910dc3699a6de2d4ead05af19dcb5859cf1b9100b442695bdfbcfb64),
  unwrap [0x00df…3788](https://www.pharosscan.xyz/tx/0x00df827ebce74a2c9fdd590bc65732d1eab7c8e31516c46009c9949845bb3788)
- buy: simulated on fresh state, `Slippage()`. Permanent, so no buy transaction was sent
- rollback: unwrap has nothing to undo, pMusk bought back (1,120)
  [0x7353…b8da](https://www.pharosscan.xyz/tx/0x7353df33cca952ba8054e6d7c33f06c856e3034ddfb53c77123b77900678b8da),
  the allowance was already back to 0 (the sale used it up)

**Earlier runs**, made with the first version (its demo switches `--fail-at` and `--drop-at` were replaced by
the real-life options above):

- A clean rotation pMusk → pPeng ([`02-rotation-done.txt`](examples/02-rotation-done.txt)), and a first bag
  ([`01-enter-pmusk.txt`](examples/01-enter-pmusk.txt)).
- A revert on chain ([`04-forced-failure-rolled-back.txt`](examples/04-forced-failure-rolled-back.txt)): the buy
  was sent unsimulated with 10x the quote as `minOut` and reverted with `Slippage()`
  [0x936b…9135](https://www.pharosscan.xyz/tx/0x936b6b6896d65d39e6566a12b22269fbd3a62febfa66539d36ba270a041e9135);
  re-simulated, still `Slippage()`, rolled back: Penguin bought back
  [0x2888…e9f](https://www.pharosscan.xyz/tx/0x28880df88a351af61289f7911cb244fe89d98d2f3d55bc58f473378c10b28e9f).
  That's where the decoded reason comes from.
- A real recovery ([`03-underpriced-then-stuck-then-resumed.txt`](examples/03-underpriced-then-stuck-then-resumed.txt)):
  the RPC rate limit hit while waiting for the unwrap receipt, the first version took it for a failed step and
  started rolling back, and its "unwrap what's left" found no WPROS (the unwrap had gone through) and stopped as
  `stuck`, sending nothing more. After the fixes, `resume` finished the rollback: Penguin bought back
  [0xa7fa…6415](https://www.pharosscan.xyz/tx/0xa7fae71ec5b2ddb09c4df9115609d0c03a877e0d81993881d20bf8b152536415).
  Not planned, but a good test of the stuck state and of resume.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/06-trenchsaga/skill/trenchsaga`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/06-trenchsaga/skill/trenchsaga -a claude-code
```

Then put the key of a small test wallet into the `.env` file in the data folder (`setup` prints where it is:
`%APPDATA%\trenchsaga` on Windows, `~/.config/trenchsaga` elsewhere, or `TRENCHSAGA_HOME`):

```text
PRIVATE_KEY=0x...
```

Never paste a key into a chat. Without the agent, the same file runs directly:

```bash
node .claude/skills/trenchsaga/scripts/trenchsaga.mjs setup
```

```bash
node .claude/skills/trenchsaga/scripts/trenchsaga.mjs enter 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F 0.01 --yes
```

```bash
node .claude/skills/trenchsaga/scripts/trenchsaga.mjs plan 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F 0xe534Dadb1E32A9DF075ffcAE0D636fF472A040db
```

```bash
node .claude/skills/trenchsaga/scripts/trenchsaga.mjs rotate 0x5c3E0e4B1BE0851DCbC5F6a5cc04d799AcbE8B7F 0xe534Dadb1E32A9DF075ffcAE0D636fF472A040db --yes
```

## Commands

| Command | What it does |
|---|---|
| `setup` | data folder, whether a key is there (its address only), settings |
| `config set k=v ...` | `max_buy_pros` (0.01), `slippage_pct` (2), `max_attempts` (3), `receipt_timeout_sec` (30) |
| `plan <A> <B> [--amount N]` | what a rotation would do, with quotes. Sends nothing |
| `rotate <A> <B> --yes` | runs it (all of A by default, `--amount` for part of it) |
| `enter <B> <PROS> --yes` | buys a first bag of B |
| `status [id]`, `log [id]` | which step a saga is in, and its journal |
| `resume [id]` | continues an interrupted saga |

Options for `plan` and `rotate`: `--min-out N` buys B only if you get at least N of it (otherwise the
rotation is rolled back to A; `plan` warns when the current quote is below it), `--start-fee G` tries a max
fee of G gwei first and goes on at the normal fee if the node refuses it. Exit codes: 0 done, 1 error, 2 bad
input or no key, 3 rolled back (or stuck while rolling back).

## How it's built

- [`src/saga.ts`](src/saga.ts): the engine (steps, retry policy, replacement by nonce, rollback, journal).
- [`src/rotation.ts`](src/rotation.ts): the four steps and their undos, with the on-chain checks.
- [`src/chain.ts`](src/chain.ts): Pharos through viem (simulation, sending, receipt polling, reading at a
  block, decoding reverts).
- [`src/store.ts`](src/store.ts): data folder, `.env`, state files and the journal.
- [`skill/trenchsaga`](skill/trenchsaga): `SKILL.md` for the agent and the bundled `scripts/trenchsaga.mjs`
  (built from `src` with `npm run build`).

## Tests

```bash
npm test -w 06-trenchsaga
```

The engine runs on a scripted fake chain: steps strictly in order, the state saved on every transition, a
replacement keeping its nonce and paying more, a refused send resent, a revert retried when the fresh
simulation passes, a late receipt used instead of sending twice, a failed chain read not failing the step,
giving up after `max_attempts`, the rollback in reverse order, a step that can't succeed never being sent, the user's floor going
into the buy's minOut, a
stuck rollback, resume after a crash, and decoding `Slippage()` from the data of the real reverted buy.
