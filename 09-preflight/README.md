# 09 · Dry-Run Executor (SkillEngine · Medium)

**preflight** is an agent skill that dry-runs a Pharos mainnet transaction before it goes out. It simulates
the transaction on the current chain state and tells you whether it succeeds or reverts (and why), what gas it
costs, and what it changes: PROS and token balances and allowances, before and after. Then it says GO or NO-GO.
Sending goes through it as well: it simulates again right before signing and won't sign anything that fails.

It takes the transaction in whatever form you have it: "send 0.005 USDC to 0x…", an approve, any contract call
by its signature, or raw call data another tool prepared.

## What a check does

1. **Simulate without broadcasting.** `eth_call` and `estimate_gas` through the Pharos Chain MCP
   (`mcp.pharos.xyz`), from the sender's address, with the real value and call data.
2. **Success or revert, with the reason.** Revert data is decoded: `Error(string)`, `Panic(code)` with what the
   code means, and custom errors by selector (OpenZeppelin's ERC20 errors, Prosper's `Slippage()`,
   `DeadlineExpired()` and others; a test checks every selector against its signature).
   `ERC20InsufficientBalance` is spelled out in tokens: "has 1 USDC, needs 10".
3. **Gas cost.** Estimate x the current gas price in PROS and in dollars (Chainlink PROS/USD on Pharos), plus
   the most it can cost (limit = estimate + 20%, max fee = gas price x 1.5). In task 08 I checked on mainnet
   that Pharos charges the gas used, so estimate x price is the expected cost.
4. **Before and after.** Pharos' RPC doesn't support `prestateTracer` (it answers "prestateTracer currently not
   supported"), so the changes come from `debug_traceCall` with `callTracer`: PROS moved by every call with
   value, every ERC-20 `Transfer` and `Approval`, and WPROS `Deposit` / `Withdrawal`. The "before" values are read
   at the same block (`balanceOf`, `allowance`, PROS balance); "after" = before + what the trace moves. The
   sender's PROS also loses the expected gas.
5. **GO or NO-GO.** NO-GO when the simulation reverts or fails, when the wallet can't cover the value plus the
   worst-case gas, or when it sends more PROS than `max_pros_per_tx`. Warnings (still GO): an unlimited
   approval, a call with data to an address that has no code, PROS sent to yourself.

## Blocking

`preflight send <tx> --yes` is the only way it sends. It runs the full simulation again first; on NO-GO it
prints `BLOCKED` and exits with 3 without signing. There is no flag to skip it. On GO it signs locally with the
gas limit and fee from that simulation, broadcasts through the Chain MCP's `send_raw_transaction`, waits for the
receipt and compares: status, gas used against the estimate, and every token balance change from the receipt's
logs against the simulated ones, each marked AS SIMULATED or DIFFERENT.

## Real checks on mainnet (2026-10-30)

From a small test wallet, nothing sent:

```text
does   transfer 0.005 USDC to 0x89Ba8B984A709a1f02350dbd58b3e730119bb2Aa

SIMULATION  success
GAS         estimate 58,605 at 10 gwei = 0.00058605 PROS (~$0.0003)
            limit 70,326, max fee 15 gwei: at most 0.00105489 PROS (~$0.0006)
CHANGES     before -> after
  PROS you                               0.10501121 PROS -> 0.10442516 PROS  (-0.00058605)
  USDC you                               2.953684 USDC -> 2.948684 USDC  (-0.005)
  USDC 0x89ba…b2aa                       0.02 USDC -> 0.025 USDC  (+0.005)

VERDICT  GO: safe to send as simulated
```

```text
does   transfer 10 USDC to 0x89Ba8B984A709a1f02350dbd58b3e730119bb2Aa

SIMULATION  REVERT: Error("ERC20: transfer amount exceeds balance") (in 0xc879c018db60520f4355c26ed1a6d572cdac1815)
VERDICT  NO-GO: the simulation reverts: Error("ERC20: transfer amount exceeds balance")
```

A buy on the Prosper curve (pMusk for 0.001 PROS) shows the whole path: PROS wrapped to WPROS, the WPROS going
to the market, the pMusk coming back, gas 235,260. The same buy with a minimum out the curve can't give
reverts with Prosper's `Slippage()` and is NO-GO. An unlimited USDC approval is GO with
`WARNING unlimited approval`.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/09-preflight/skill/preflight`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/09-preflight/skill/preflight -a claude-code
```

Checks need no key (`--from <address>` simulates as anyone). To send, put the key of a small test wallet into
the `.env` file in the data folder (`preflight --help` prints where: `%APPDATA%\preflight` on Windows,
`~/.config/preflight` elsewhere, or `PREFLIGHT_HOME`):

```text
PRIVATE_KEY=0x...
```

Never paste a key into a chat. Without the agent:

```bash
node .claude/skills/preflight/scripts/preflight.mjs check token USDC <recipient> 0.005 --from <your address>
```

## Commands

| Command | What it does |
|---|---|
| `check <tx> [--from <address>]` | simulate: GO or NO-GO, revert reason, gas cost, before -> after |
| `send <tx>` | the same from your wallet; says what `--yes` would send |
| `send <tx> --yes` | simulate again, sign and send only on GO, compare the result |
| `log`, `wallet`, `config set k=v` | past checks and sends, the signer, `gas_buffer_pct` (20), `max_fee_multiplier` (1.5), `max_pros_per_tx` (1) |

`<tx>`: `pros <to> <amount>`, `token <token|USDC|WPROS> <to> <amount>`, `approve <token> <spender> <amount|max>`,
`call <to> "<fn(types)>" [args...] [--value PROS]`, `raw <to> <0xdata> [--value PROS]`. `--json` gives the whole
report as JSON. Exit codes: 0 GO / sent as simulated, 1 error, 2 bad input or no key, 3 NO-GO (blocked),
4 sent but different from the simulation.

## Limits

- Pharos mainnet only: the hosted Chain MCP is for chain 1672.
- The trace shows ERC-20 and WPROS movements; other state a contract changes (its own storage) isn't listed.
  An NFT `Transfer` is not counted as a balance change.
- A simulation is a prediction at one block. Something can change before the transaction is mined, which is
  why `send` simulates again right before signing and compares afterwards.

## How it's built

- [`src/chain.ts`](src/chain.ts): the Chain MCP client (simulation, estimate, reads, nonce, broadcast,
  receipts) and `debug_traceCall` on the Pharos RPC.
- [`src/sim.ts`](src/sim.ts): the simulation, the changes from the trace, the verdict and the report.
- [`src/errors.ts`](src/errors.ts): revert reasons.
- [`src/cli.ts`](src/cli.ts), [`src/store.ts`](src/store.ts): commands, the transaction forms, `send`, data
  folder and journal.
- [`skill/preflight`](skill/preflight): `SKILL.md` for the agent and the bundled `scripts/preflight.mjs`
  (built from `src` with `npm run build`).

## Tests

```bash
npm test -w 09-preflight
```

They run on a fake chain that simulates, traces and mines a token: the selector table, revert decoding, what a
trace changes (failed frames and NFTs left out), a GO with before and after, a revert that blocks `send`, a
wallet that can't pay the gas, an unlimited approval, `send` without and with `--yes`, and a mined result that
differs from the simulation.
