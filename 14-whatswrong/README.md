# 14 · dApp Support Agent (Support · Easy)

**whatswrong** is an agent skill for the moment someone says "my transaction failed, why?". Give the agent the
hash: whatswrong reads the transaction and its receipt through Pharos Chain MCP, follows the call trace down to the
contract that actually refused (often a token or a vault two calls deep, not the app you called), decodes the
reason, and sorts it into a kind of failure. Then it does what a support desk usually doesn't: it **rebuilds the
transaction the way the fix says and replays it**, so "raise your minimum" or "approve first" comes with a yes or
no from the chain. The agent turns the facts into a plain answer in the user's own language.

It only reads. Nothing is signed or sent, no key is needed.

How it works, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md).

## Nine real failures from Pharos mainnet

All found among other people's failed transactions on Pharos mainnet, in three protocols, and diagnosed by the
tool as shown (tests replay each one from a recording of the chain's answers: `test/tapes/`).

| Protocol | What happened | Kind | Checked fix | Tx |
|---|---|---|---|---|
| Prosper | A sale sent again 13 blocks after the same sale went through: the approval was used up and the tokens were gone | `allowance` + balance | approve alone wouldn't help: next error `ERC20InsufficientBalance` | [0xe8b01dc9…](https://www.pharosscan.xyz/tx/0xe8b01dc91222df4f54aa3e07ad25404da394f2e9b32e08eaf9e73eac9bd09586) |
| Prosper | A buy cancelled by the market's own price guard | `slippage` (`Slippage()`) | contract layout not public: only the unchanged retry is checked | [0xbfe6c7c3…](https://www.pharosscan.xyz/tx/0xbfe6c7c31de6e40e0c93f08e69025caf62fb1ff1678224208ae969d08259cb69) |
| Prosper | Sent with a 55,622 gas limit | `out_of_gas` | passes with 8x the gas at that block | [0x050199ea…](https://www.pharosscan.xyz/tx/0x050199ea5c1651022cc8882e062779b7b6ad6479da8425439cd06b275a11c38d) |
| Faroswap | "Too little received" | `slippage` | today the same minimum is met: only a fresh deadline is needed (the price was just bad at that moment) | [0x789d7715…](https://www.pharosscan.xyz/tx/0x789d7715e28b80e914cdcf71fb2e16a86f1aa9fdc2aab6cc5c4283cb406adacd) |
| Faroswap | Fine one block earlier, failed inside its block: the sender's own swap right before it moved the price | `same_block` | today the same minimum is met with a fresh deadline | [0x59925ccc…](https://www.pharosscan.xyz/tx/0x59925ccc327c5f329736bfbbe752ee4a2a3b48561dd4f23995743ddcb34d77cf) |
| Faroswap | "Transaction too old" | `deadline` | passes with a fresh deadline | [0xc4dabdab…](https://www.pharosscan.xyz/tx/0xc4dabdaba58142ce1313bc1a6c50a388d09dc32f13b97784d1e754bfd356a43b) |
| Faroswap | "STF": the wallet didn't hold the 100 WPROS it swapped | `balance` | wallet still holds 0 WPROS | [0xa9435d84…](https://www.pharosscan.xyz/tx/0xa9435d844d7d0d3644584f42a4646c6c3db209db4a81127b46133df9fe80386d) |
| Harbor (roxUSDC, Morpho) | Withdrawal of 274,341.73 USDC while the vault held 274,341.26 idle: 47 cents short | `vault_liquidity` | vault holds 0.40 USDC idle today | [0x3b7aa7df…](https://www.pharosscan.xyz/tx/0x3b7aa7df0eafa9432b62b83e47e9ac3040bb27f9af679c5bc0d397829883d205) |
| Harbor (SharpByte, Morpho) | Deposit of 1,197.7 USDC from a wallet without it | `balance` | wallet holds 0 USDC today | [0x3a79b7b6…](https://www.pharosscan.xyz/tx/0x3a79b7b623a240ad4354b4bc21adf2a2674e9b5f7be639b8cb95fcf1bb547619) |

The fact sheet for the Prosper double sale:

```text
tx                 0xe8b01dc91222df4f54aa3e07ad25404da394f2e9b32e08eaf9e73eac9bd09586 (block 21392110) https://www.pharosscan.xyz/tx/0xe8b01dc91222df4f54aa3e07ad25404da394f2e9b32e08eaf9e73eac9bd09586
status             FAILED, 0xfddc508e on 0x63ffadf944583d8e4fdc30144efdfe3bdc2122f5, from 0xaa5b49c725127e8e417880d0808b3e24610e0a86
broke at           2 call(s) deep: transferFrom(address,address,uint256) on 0x0220d3650f9d750775dc2586c8b9825a891c74b8 (0x63ff…22f5 -> 0x0220…74b8)
said               ERC20InsufficientAllowance
kind               allowance
gas                used 98311 of 370818
owner              0xAa5B49C725127e8E417880d0808b3e24610E0a86
needed             1,487,747.084574 pair
balance            0 pair
allowance          0 pair
spender            0x63ffadf944583d8e4fdc30144efdfe3bdc2122f5
also short         balance
left before        the same amount went to the same place 13 blocks earlier, https://www.pharosscan.xyz/tx/0x1b84dc1538be4eb78065f93e71f9c6e1ba32f45051e4c02ac0b85e6236e2f48e
now                the same tx, unchanged, still fails right now: ERC20InsufficientAllowance
fix fails          the same call at the block before it, as if 0x63ffadf944583d8e4fdc30144efdfe3bdc2122f5 had been approved for 1,487,747.084574 pair
  approveFor       1,487,747.084574 pair
  spender          0x63ffadf944583d8e4fdc30144efdfe3bdc2122f5
  then             ERC20InsufficientBalance
```

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer and an agent that supports skills, such as Claude Code. Ask it
to install `https://github.com/vi11abajo/Agentic-Economy/tree/main/14-whatswrong/skill/whatswrong`, or:

```bash
npx skills add https://github.com/vi11abajo/Agentic-Economy/tree/main/14-whatswrong/skill/whatswrong -a claude-code
```

Then paste a failed tx hash: "my swap failed, why? 0x…". Without the agent:

```bash
node .claude/skills/whatswrong/scripts/whatswrong.mjs 0x59925ccc327c5f329736bfbbe752ee4a2a3b48561dd4f23995743ddcb34d77cf
```

`--json` gives the same facts as JSON, `--quick` skips the fix check.

## How the task's requirements are met

| Requirement | Where |
|---|---|
| Accepts a tx hash and fetches the tx and receipt via Chain MCP | `get_transaction` and `get_transaction_receipt` through mcp.pharos.xyz; the replays and block reads also go through the MCP |
| Identifies the failure cause | trace to the contract that refused, decoded reason (string, panic, known custom errors, others named through the 4byte list), reads at the tx's block; 12 kinds |
| Explains without jargon and suggests a fix | the skill tells the agent how to explain; fixes are replayed on chain ("fix works / fails", plus what failed next) or, for balances and vault cash, looked up ("looked up: ok / short") |
| At least 3 different failure types | 9 real mainnet failures, 7 kinds, 3 protocols (table above) |

## Limits

- Pharos Chain MCP has no call traces and no state overrides, so those two go to rpc.pharos.xyz directly
  (`WHATSWRONG_RPC` points them elsewhere; the tool expects Pharos-style traces, where a proxy's DELEGATECALL frame
  carries the proxy's address). If the trace endpoint is down, the diagnosis carries on with the MCP replay alone.
- Only the EVM saying no counts as a reason. A node that can't answer makes the run fail with that message, and a
  value we couldn't read is printed as "unknown", never as zero.
- A replay "at the block before" sees the state before the whole block, not the exact moment inside it. When that
  replay passes, the tool says so (`same_block`) and lists the earlier transactions in the block.
- Fixes are rebuilt only where the call layout is known (Faroswap's router, ERC-20 approvals, ERC-4626 vaults, gas).
  Prosper's router isn't verified, so for its slippage the tool only checks an unchanged retry.

## Tests

```bash
cd 14-whatswrong && npm install && npm run build && npm test
```

Revert decoding and trace walking on real fixtures; the nine mainnet cases end to end, replayed from tapes of the
chain's real answers (`test/record-tapes.mjs` re-records them); and the odd ones no tape covers, on a hand-built
chain: a failed deployment, a node that can't answer, a trace endpoint that's down, a deadline that lapsed between
blocks, a silent revert that burned all its gas, a plain transfer over the balance, a router short of cash, and a
caught inner failure that isn't the culprit.
