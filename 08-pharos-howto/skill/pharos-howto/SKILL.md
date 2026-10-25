---
name: pharos-howto
description: >
  pharos-howto: handles "how do I do X on Pharos?" end to end. Finds the answer in the Pharos Developer Docs MCP
  with its sources, turns it into a plan where every step cites a docs page, carries it out through the Pharos
  Chain MCP (anything that moves funds is prepared first and signed with the user's key only after they say yes),
  then checks the result on chain against the plan. Says so plainly when the docs don't cover something. Use
  whenever the user asks how to do something on Pharos, or asks you to do something on Pharos for them.
requires:
  anyBins:
  - node
---

# pharos-howto

Run with Node 20+ from this skill's folder: `node scripts/howto.mjs <command>` (use the absolute path of
`scripts/howto.mjs` when running from elsewhere). One bundled file, no install.

| Command | What it does |
|---|---|
| `ask "<how do I ...>"` | asks the Docs MCP, starts plan N with the answer and its sources; exit 3 = not in the docs |
| `search "<query>" --plan N`, `page <docs url> --plan N` | reads more of the docs; what it reads becomes a source of plan N |
| `steps N <steps.json>`, `steps N -` | attaches your steps to plan N (from a file or stdin); refused if a step cites a page not read for the plan |
| `run N` | does the reads and prepares the transactions; nothing is sent |
| `run N --yes` | the same, then signs with the key in .env, sends through the Chain MCP, waits, checks |
| `verify N` | checks the last run's transactions again (one that was mined late) |
| `show N`, `list`, `wallet`, `config [set k=v]` | a plan and its runs, all plans, the signer address and PROS, settings |

## How to handle a request

1. **Docs first, always.** Run `ask` with the user's question in their words before doing anything else. Show
   the answer short and list the sources it gives. If the user only asks how (no "do it", no amount or
   address yet), stop here: explain the documented steps with their sources and offer to do it. Go on to the
   plan when they ask you to do it.
2. **Not in the docs (exit 3):** tell the user the docs don't cover it, show the closest pages, and stop. Don't
   fill the gap from general knowledge, don't improvise steps. If only part is covered, do that part and name
   the part that isn't.
3. **Read what the plan needs.** When the user asks you to do it after a how-question, keep using that plan N.
   If the answer leaves out a detail you need (an address, a signature, a number), get it with `page` or
   `search` with `--plan N`. Only pages read for the plan can be cited.
4. **Write the plan** as JSON (schema below), in a file or straight on stdin: `steps N - <<'EOF' ... EOF`.
   Each step cites the docs page it comes from. Give every step the checks that would prove it worked, taken
   from what the docs claim (a status, an event, a balance change, how the fee is charged). Then attach it with
   `steps N`. Tell the user the plan: the steps, with their source next to each.
5. **Dry run.** `run N` does the reads and prepares any transaction. Paste what it printed: target, call, value,
   gas limit, fees, worst-case cost. Ask the user plainly whether to sign and send it.
6. **Only after a clear yes:** `run N --yes`. Never add `--yes` on your own.
7. **Report against the plan.** Paste the run output, then say per step whether it matched. If a check failed,
   say what the docs said, what the chain did, and which one was right. Give the explorer link for each tx.

Things the chain can't do from here (an exchange, a bridge's other chain, a web form, buying PROS): explain the
documented steps and say clearly that this part is the user's to do.

## The key

`howto --help` says whether a key is there (the signer's address only). `run --yes` signs with `PRIVATE_KEY` (or
`MNEMONIC`) from `.env` in the data folder (`howto --help` prints the folder). The user puts it there themselves.
Never ask for a key, never read or print the .env, never pass a key on a command line. `wallet` shows the signer's
address and PROS. Without a key, `run N --from <address>` previews what would be prepared.

## steps.json

```json
{
  "goal": "pay 0.01 USDC to 0xRecipient",
  "steps": [
    { "title": "Check my USDC balance", "source": "https://docs.pharos.xyz/getting-started/token-registry",
      "read": { "call": { "to": "0xUSDC", "sig": "balanceOf(address) view returns (uint256)", "args": ["self"] } },
      "expect": [ { "at_least": "10000" } ] },
    { "title": "Transfer 0.01 USDC", "source": "https://docs.pharos.xyz/getting-started/token-registry",
      "tx": { "to": "0xUSDC", "sig": "transfer(address to,uint256 amount)", "args": ["0xRecipient", "10000"] },
      "expect": [ { "status": "success" },
        { "event": { "address": "0xUSDC", "event": "Transfer(address indexed from,address indexed to,uint256 value)",
                     "args": { "from": "self", "to": "0xRecipient", "value": "10000" } } },
        { "erc20_delta": { "token": "0xUSDC", "holder": "0xRecipient", "amount": "0.01" } } ] }
  ]
}
```

- `"self"` is the signer's address. Each step has exactly one of `read` or `tx`.
- `read`: `balance {address}` (PROS), `call {to, sig, args}`, `gas_price {}`, `receipt {hash}`, `code {address}`,
  `logs {address, event, args?, fromBlock, toBlock}` (at most 1000 blocks; `"latest"` and `"latest-999"` work).
- `tx`: `to`, optional `sig` + `args` (integers as strings, in the token's smallest unit), `value_pros`,
  `gas_buffer_pct` (default 20, from the Gas Model page) or `gas_limit`.
- `expect`: `status` ("success" or "reverted"), `event`, `erc20_delta {token, holder, amount}` and
  `native_delta {holder, amount}` (human units, signed), `fee_charged_on` ("gas_limit" or "gas_used"), and for
  reads `equals` / `at_least`. Balance changes are measured at the transaction's block against the block before.
- Steps run in order and stop at the first failure.

Settings: `gas_buffer_pct` 20, `max_fee_multiplier` 1.5 (max fee per gas = gas price x this), `max_pros_per_tx` 1
(a transaction sending more PROS is refused), `receipt_timeout_sec` 90. Change them only when the user asks.
