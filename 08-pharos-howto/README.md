# 08 · Doc-Grounded Builder Agent (Cross-tool · Hard)

**pharos-howto** is an agent skill for "how do I do X on Pharos?". The agent finds the answer in the Pharos
Developer Docs MCP, turns it into a plan where every step cites the docs page it comes from, does it through the
Pharos Chain MCP, and then checks on chain whether things went the way the plan said. Anything that moves funds
is prepared first and signed with your key only after you say yes. When the docs don't cover something, it says
so and stops.

It works for any question, not a fixed list. The agent writes the plan itself; the skill makes sure the plan is
grounded and that the result gets checked.

## How a request goes

1. **Docs first.** `howto ask "<question>"` sends the question to the Docs MCP (`askQuestion` on
   `docs.pharos.xyz/~gitbook/mcp`) and starts plan N with the answer and its sources. When the agent needs more
   detail, `howto page <url> --plan N` and `howto search "<query>" --plan N` read more of the docs, and those
   pages become sources of the plan too.
2. **Not in the docs.** If the Docs MCP has no documented answer, `ask` says `NOT IN THE DOCS` and exits with 3.
   That plan can't take steps and can't run, so the agent has nothing to improvise with. It tells you and shows
   the closest pages. (The check for a miss is the one from rtfm in task 04, tested on recorded replies.)
3. **Plan.** The agent writes the steps as JSON: reads (balance, contract call, gas price, receipt, logs, code)
   and transactions (target, function signature, arguments, value), each with a `source` and the checks that
   would prove it worked. `howto steps N <file>` refuses a step that cites a page nobody read for this plan.
4. **Dry run.** `howto run N` does the reads and prepares each transaction: `estimate_gas` on the Chain MCP plus
   the 20% buffer from the Gas Model page, the current gas price, the nonce, the worst-case cost. Nothing is
   sent. The agent shows this and asks you.
5. **Send.** After your yes, `howto run N --yes` signs locally with the key from `.env` and broadcasts the signed
   bytes with the Chain MCP's `send_raw_transaction`. The MCP server never sees a key. Then it waits for the
   receipt.
6. **Check against the plan.** Every expectation is checked on chain at the transaction's block against the
   block before it: status, an event with its arguments, a token or PROS balance change, how the fee was
   charged. The run ends with `OUTCOME success` (every check matches) or `OUTCOME failure` with the step and
   what the chain did instead (exit code 4).

Everything goes through the Chain MCP: reads, estimates, nonce, broadcast, receipts. The only local part is
signing. Every plan is saved with its answer, sources, steps and runs in `plans/N.json`, and every command that
touched the docs or the chain goes to `journal.jsonl`.

## When the docs are wrong

The Gas Model page says the transaction fee is "Charged by gas_limit at inclusion time" and that refunds don't
change the charge. So the plan for "how do I send a transaction without overpaying for gas?" expects
`fee_charged_on: gas_limit`. The check reads the sender's PROS balance at the block before and at the block of
the transaction and compares the drop with gas used x price and with gas limit x price.

I tried the same check on a random mainnet transaction first: tx
[`0xd6cf9632…62ca`](https://www.pharosscan.xyz/tx/0xd6cf96328f082d8019879d107ecfa155e000389719cc1252162429f49ef262ca)
had a gas limit of 10,000,000 and used 175,141. The sender paid exactly 175,141 x 10 gwei = 0.00175141 PROS, not
the 0.1 PROS the limit would cost. So on mainnet the fee is charged on the gas used, and the run reports that
step as a failure against the plan, with both numbers. That's what checking against the plan is for.

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills (I tested with Claude
Code). Ask your agent to install it from
`https://github.com/vi11abajo/Agentic-Economy/tree/main/08-pharos-howto/skill/pharos-howto`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/08-pharos-howto/skill/pharos-howto -a claude-code
```

Then ask it things like "how do I pay someone in USDC on Pharos from my agent's wallet?". Questions and reads
need no key. To send transactions, put the key of a small test wallet into the `.env` file in the data folder
(`howto --help` prints where it is: `%APPDATA%\pharos-howto` on Windows, `~/.config/pharos-howto` elsewhere, or
`HOWTO_HOME`):

```text
PRIVATE_KEY=0x...
```

Never paste a key into a chat. Without the agent, the same file runs directly:

```bash
node .claude/skills/pharos-howto/scripts/howto.mjs ask "how do i check that a usdc payment to my address actually arrived on pharos?"
```

## Commands

| Command | What it does |
|---|---|
| `ask "<how do I ...>"` | asks the Docs MCP, starts plan N with the answer and its sources |
| `search "<query>" --plan N`, `page <url> --plan N` | reads more of the docs as sources of plan N |
| `steps N <steps.json>` | attaches the steps (schema in [`SKILL.md`](skill/pharos-howto/SKILL.md)) |
| `run N` | reads and prepares, sends nothing (`--from <address>` previews without a key) |
| `run N --yes` | signs, sends through the Chain MCP, checks the result |
| `verify N` | checks the last run's transactions again |
| `show N`, `list`, `wallet` | a plan with its runs, all plans, the signer's address and PROS |
| `config set k=v` | `gas_buffer_pct` (20), `max_fee_multiplier` (1.5), `max_pros_per_tx` (1), `receipt_timeout_sec` (90) |

Exit codes: 0 done, 1 error, 2 bad input or no key, 3 not in the docs, 4 the result doesn't match the plan.

## Limits

- Pharos mainnet only: the hosted Chain MCP is configured for chain 1672.
- It does what can be done with a transaction from your wallet. An exchange, a bridge's other chain, a web form
  or buying PROS stays with you; the agent explains the documented steps for those.
- A transaction sending more than `max_pros_per_tx` PROS is refused. Token amounts are whatever the plan says,
  so read the dry run before saying yes.

## How it's built

- [`src/docs.ts`](src/docs.ts), [`src/answer.ts`](src/answer.ts): the Docs MCP client and the reply parsing (from
  task 04).
- [`src/chain.ts`](src/chain.ts): the Chain MCP client (reads, estimates, nonce, broadcast, receipts).
- [`src/plan.ts`](src/plan.ts): the plan format, source checks, function and event signatures.
- [`src/run.ts`](src/run.ts): reads, preparing and signing transactions, the checks at the block.
- [`src/cli.ts`](src/cli.ts), [`src/store.ts`](src/store.ts): commands, data folder, `.env`, plans and journal.
- [`skill/pharos-howto`](skill/pharos-howto): `SKILL.md` for the agent and the bundled `scripts/howto.mjs`
  (built from `src` with `npm run build`).

## Tests

```bash
npm test -w 08-pharos-howto
```

They run the CLI on recorded Docs MCP replies and a fake chain that mines what it's sent: a plan from the docs,
a question the docs don't cover, a step citing a page nobody read, a dry run that sends nothing, a signed
transaction checked against the plan, a plan the chain disagrees with, a token payment checked by its event and
both balances, and the PROS cap.
