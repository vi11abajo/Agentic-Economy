# whatswrong: architecture

```text
   agent (Claude Code + the whatswrong skill)        "my swap failed, why? 0x…"
     |  node whatswrong.mjs <tx>
     v
   cli.ts ── autopsy.ts ── what kind of failure, with facts read at the tx's block
          ── remedy.ts ── rebuild the tx the way the fix says and replay it
          ── report.ts ── the fact sheet the agent explains in plain words
     |
   witness.ts: every question to the chain goes through one object
     ├─ Pharos Chain MCP (mcp.pharos.xyz): get_transaction, get_transaction_receipt, eth_call at any block,
     │                                     estimate_gas, get_block with transactions, get_logs
     ├─ rpc.pharos.xyz: debug_traceTransaction (callTracer), eth_call with state overrides
     └─ api.4byte.sourcify.dev: names for unknown selectors (optional)
```

## The investigation (`autopsy.ts`)

1. Transaction and receipt from the MCP. A successful receipt ends it: "this didn't fail".
2. The call trace. `whereItBroke` (`clues.ts`) follows failing calls down to the deepest one: that's the contract
   that really refused, and its revert bytes are the most honest reason. Calls that failed and were caught stay in
   the trace, so at each level it prefers the child whose revert the parent passed on, else the last failure.
3. A replay through the MCP at the block before, with the same sender, data, value and gas.
4. Then, in this order:
   - **a deployment** (no `to`): only its own trace speaks, so it's `deployment_failed`;
   - **out of gas**: the deepest frame ran out; only without a trace does "(almost) all gas used, no reason" count;
   - **deadline**: a reason like "Transaction too old" wins even when the block before was still in time;
   - **same block**: the replay passes although the tx failed, so something earlier inside the block changed the
     state; the earlier transactions of that block that touched the same contract or came from the same sender
     are listed;
   - **a token move that bounced** deep inside: for `transferFrom` the owner's balance and allowance at the block
     decide between `allowance` and `balance` (the token's own error wins when it names one); for a `transfer` that
     exceeds what the payer holds, it's `balance` when the payer is the user, `vault_liquidity` when the payer is an
     ERC-4626 vault, and `contract_short` for any other contract. When the balance is short, the token's
     Transfer logs of the last 2,000 blocks are searched for the same amount going from the same wallet to the same
     place: that's how a repeated send shows up;
   - **the words**: `Slippage()`, "Too little received", "Transaction too old", OpenZeppelin errors,
     `Unauthorized()` and friends.

## Proving the fix (`remedy.ts`)

| Kind | What gets replayed |
|---|---|
| any | the unchanged transaction on the latest block ("would a plain retry work now?", and what it says if not) |
| out_of_gas | the same call at the block before it with 2x, 4x, 8x the gas, first one that passes |
| allowance | the same call at the block before it, with the token's allowance slot patched to the needed amount (slot found by probing the usual mapping layouts through a state override) |
| balance | looked up, not replayed: the wallet's balance of that token now |
| deadline, slippage, same_block | Faroswap swap with only the deadline refreshed and the user's own minimum kept; if that still fails on the minimum, the pool's price today with no minimum, then a minimum 0.5% under it (that proves the swap can execute, not that the price will hold) |
| vault_liquidity | looked up, not replayed: the vault's idle asset now and `maxWithdraw` for the wallet |

A patched replay that still fails reports what it failed with next ("then"), which is often the real second
problem.

## Tests without a network

`taped()` wraps the real witness and writes down every question and answer; `fromTape()` answers only from such
a recording and complains loudly about anything else. `test/record-tapes.mjs` ran the nine real cases once, and
the tests replay those exact investigations.
