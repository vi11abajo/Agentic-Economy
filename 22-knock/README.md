# 22 · Natural-Language Payment Agent

**knock** is an agent skill that turns "send 100 USDC to alice.eth" into a checked, human-readable summary and an
unsigned transaction (or a wallet signing request) on Pharos mainnet. It holds no key. Your own browser wallet
signs, on a page served from your machine.

The name is the idea: before it prepares a payment, knock knocks on the recipient's address and looks at who
answers. That turned out to matter on the very first example from the task. Pharos has no name service (no ENS
registry on chain, nothing in the docs), so a `.eth` name can only mean what ENS on Ethereum says. And on Ethereum,
`alice.eth` points to `0xcd2E72aE…1c75`, a **1-of-2 Safe multisig**. On Pharos nothing was ever deployed at that
address. Send USDC there and it lands at an address whose owners may have no way to touch it. The three other builds
of this task I read refuse names outright; knock resolves the name, compares the address on both chains, and stops this
one with the reason in plain words.

The same "who lives there, and what does the money do when it arrives" question catches other things the format
checks don't: USDC sent to the USDC contract (it refuses: the contract blacklisted itself), PROS sent to WPROS
(it goes through and comes back to you as WPROS), and Hardhat's account #0 (the key is public, and on Pharos it's
already EIP-7702 delegated to someone's contract). knock finds these by simulating the exact transfer from your
address at the latest block and tracing it, not from a list.

For USDC there's a second way to pay: sign an EIP-3009 `ReceiveWithAuthorization` message instead of a
transaction. Only the payee can turn it into a transfer (the contract checks `msg.sender == to`), so a leaked
signature can't be redirected, and the payer needs no PROS for gas.

## Quick start

```bash
cd 22-knock && npm ci && npm run build
node skill/knock/scripts/knock.mjs pay "send 0.01 USDC to alice.eth" --from 0xYourAddress
node skill/knock/scripts/knock.mjs pay "send 5 dollars to 0x..." --from 0xYourAddress --answer "USDC"
node skill/knock/scripts/knock.mjs who vitalik.eth
node skill/knock/scripts/knock.mjs pay "send 0.01 USDC to myself" --from 0xYourAddress --out plan.json
node skill/knock/scripts/knock.mjs sign plan.json      # then open http://127.0.0.1:8643/ where your wallet lives
node skill/knock/scripts/knock.mjs sign plan.json --detach && node skill/knock/scripts/knock.mjs signed plan.json
```

The skill is `skill/knock/` (SKILL.md plus one bundled script, no install, no keys). Exit codes are for the agent
driving it: `0` a plan is ready, `2` knock needs an answer first, `3` knock stopped the payment.

## Reading the sentence

No model inside the CLI: the agent running the skill does the talking, and knock only takes out what the words
actually say. When a reading would need a guess, it asks instead, and the answer comes back with `--answer`.

| You write | knock does |
|---|---|
| `send 100 USDC to 0x…`, `pay alice.eth 0.5 usdc` | reads amount, token, recipient in either order |
| `1.5k`, `1,250.50` | 1500, 1250.50 |
| `1,000`, `1.000`, `1.000k` | asks: "1000 or 1.0?" (`0.001` is just small, not asked) |
| `$5`, `5 dollars` | asks which token |
| `send 5 to 0x…`, `send USDC to 0x…`, `send 5 USDC` | asks for the missing part |
| `all my USDC`, `-5 USDC` | asks for a real amount |
| two amounts or two recipients | asks to send them one at a time |
| `0x4644...D3Bb` | asks for the full address |
| `to me`, `myself`, `my wallet` | pays the `--from` address |
| `USDC.e`, `USDT` | not USDC; USDT isn't on the Pharos mainnet list, so it asks for a contract address |

An answer only fills what was asked. If it contradicts the sentence ("send 1,000 USDC to bob.eth", answer
"1000, to carol.eth"), knock asks which one you meant instead of quietly switching recipients.

## The checks

Every check is a read against the chain at the latest block, and every one shows up in the summary with `ok`,
`warn` or `STOP`. One STOP and nothing is prepared.

- **Your address and the recipient:** valid hex; a mixed-case address must carry a valid EIP-55 checksum.
- **A .eth name:** ENS on Ethereum, the Pharos-specific address record (ENSIP-11, coin type `0x80000688`) first,
  then the plain address. Then the address on both chains:
  - a Safe or any other contract on Ethereum with no code on Pharos: **STOP**;
  - an EIP-7702 delegated wallet on Ethereum, or a plain wallet: **warn** (the key works on any chain; confirm the person);
  - a Pharos record that's in use on Pharos: **ok**;
  - Ethereum unreachable or the name has no address: **STOP** (no guessing).
- **The token:** the five on the Pharos docs token list (PROS, WPROS, USDC, LINK, WETH) or a contract address.
  Code must exist and `decimals()` read on chain must match the list. An unlisted token that calls itself the same
  as a listed one is a look-alike: **STOP**. Any other unlisted token: **warn**.
- **The amount:** more decimals than the token has is a **STOP**, never rounded.
- **The balance:** the token, plus PROS for the fee (amount + fee for PROS). Gas is the estimate from your
  address + 20%, max fee 2x the current gas price (Pharos reported a flat 10 gwei and a 0 priority fee on
  2026-11-07). USDC with no PROS for gas: the transfer is off, pay-by-signature stays on.
- **The recipient on Pharos:** zero address, the token's own contract, a public test key (the 20 Hardhat/Anvil
  accounts are derived from their published mnemonic at run time), an EIP-7702 delegation and to what, a
  contract, an address never used on Pharos, or yourself.
- **What the money does:** `eth_estimateGas` and `eth_call` from your address; for a contract recipient,
  `debug_traceCall` with `callTracer` and `withLog`. A revert gives its reason; a PROS send that the contract
  credits back to you (a WETH-style `Deposit` event to your address) says so; any other contract gets a line with
  the inner calls and events it produced.

## Signing: your wallet, not knock

`knock sign plan.json` serves a page on `127.0.0.1`. It uses the wallet in your browser (`window.ethereum`).
Before anything reaches the wallet, the page asks knock to build the whole payment again from the same sentence
at the latest block, and the wallet gets that fresh build, not the file. It also asks the wallet again which
account and chain it is on (they can change after Connect) and refuses another account or anything but chain
1672. After the block it compares the mined `to`, `value` and input with what it handed over.

An agent's turn ends before you get to the wallet, so the skill starts the page with `--detach`: it runs on its
own, the agent hands you the link in the chat and waits for you. When you say you've signed, `knock signed
plan.json` reads what the page saw (refused connects, the tx, the match). The page closes itself once the payment
is mined, or after 30 minutes without one.

Paying someone else by signature: the page downloads `knock-authorization.json`. The payee runs
`knock sign knock-authorization.json`; that page recovers the signer from the signature, checks the signed
message against the rest of the file, shows the payee the amount from the signed message itself, checks the
authorization is unused and unexpired, and only then lets the payee submit `receiveWithAuthorization`.

## Limits

- Only Pharos mainnet, only the five listed tokens by symbol (others by contract address), one payment at a time.
- Names: only `.eth` through ENS on Ethereum, read through a public RPC (`ETHEREUM_RPC_URL` to change it).
- A simulation says what happens at that block. The page re-checks right before you sign, but the chain can still
  move between the check and the block.
- "Never used on Pharos" can't tell a fresh wallet from a typo. knock warns; it can't know which.
- The parser is rules, not a model. Phrasings it doesn't know end up as a question, not as a guess.

## Tests

60 tests (`npm test` after `npm run build`): the parser (every row of the table above), name verdicts (Safe,
delegated, plain, ENSIP-11, unreachable), recipient verdicts, exact calldata and typed data, fee and decimals
STOPs, and the signing side (a payer who edits the amount in the file, a message changed after signing, a
tampered plan tx, the wrong chain, reading what a detached page saw). The fake chain lives in `src/fake.ts`.

## Proof

All runs below were made against Pharos mainnet (and Ethereum mainnet for names) on 2026-11-07 from the test
wallet `0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb`. Full output in [`proof/`](proof/).

### 1. alice.eth, the task's own example: STOP

[`proof/01-alice-eth.txt`](proof/01-alice-eth.txt)

```text
you: send 100 USDC to alice.eth
understood: 100 USDC to alice.eth

Not prepared: 100 USDC to alice.eth

checks
  STOP  alice.eth points to 0xcd2E...1c75, which on Ethereum is a 1-of-2 Safe multisig (v1.3.0). On Pharos there
        is nothing deployed at that address, so the Safe's owners may have no way to move money sent there. Ask
        them for an address they use on Pharos.
  ok    USDC is the contract 0xC879C018dB60520F4355C26eD1a6D572cdAC1815 from the Pharos docs token list;
        decimals() = 6 read on chain.

STOPPED: nothing was prepared, nothing was signed.
```

`gnosis.eth` is the same story (a 3-of-5 Safe on Ethereum, empty on Pharos): [`02`](proof/02-gnosis-eth.txt).
`vitalik.eth` gets a plan with a warning (EIP-7702 delegated on Ethereum, never used on Pharos): [`03`](proof/03-vitalik-eth.txt).

### 2. What the money does when it lands

| Run | Result |
|---|---|
| [`04`](proof/04-usdc-to-usdc-contract.txt) 0.01 USDC to the USDC contract | STOP: "Blacklistable: account is blacklisted" (the contract's own revert) |
| [`05`](proof/05-pros-to-wpros.txt) 0.001 PROS to WPROS | plan, warn: wrapped and comes back to you as WPROS (seen in the trace's Deposit event) |
| [`06`](proof/06-hardhat-0.txt) 0.01 USDC to Hardhat #0 | STOP: public key; warn: EIP-7702 delegated to `0xab127f4d…2b24` on Pharos |

### 3. Questions instead of guesses

[`07`](proof/07-asks-dollars.txt) "5 dollars" asks for the token; [`08`](proof/08-asks-thousand.txt) "1,000" asks
"1000 or 1.0?"; [`09`](proof/09-answered.txt) answered "1000", then STOP: the wallet holds 0.49979 USDC;
[`10`](proof/10-bad-checksum.txt) a broken checksum, STOP; [`11`](proof/11-usdt.txt) USDT, STOP, asks for a contract.

### 4. Two real payments, signed in the wallet

[`proof/13-live-sign-page.txt`](proof/13-live-sign-page.txt), plan [`13-live-self.plan.json`](proof/13-live-self.plan.json).
"send 0.01 USDC to myself", prepared by knock, signed by the wallet's owner on the `knock sign` page.

The first Connect came from another account in the wallet, and the page refused before anything was signed:

```text
recheck (transfer): BLOCKED - this was prepared for 0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb; the wallet
connected is [another account of the user, address removed]. Switch accounts, nothing was signed
```

Then, from the right account:

| | Transaction | Block | Gas used | What it shows |
|---|---|---|---|---|
| Send transfer | [`0xfe7f9b7a…bb64863`](https://www.pharosscan.xyz/tx/0xfe7f9b7ac88a11715c56d6d9687fb34b067da90e8900c04d4e0d0c14bbb64863) | 22411124 | 37,435 | `transfer` on USDC, one Transfer event of 10000 (0.01 USDC); mined input equals the plan's `tx.data` byte for byte |
| Pay by signature | [`0x79d346c3…af77d45fe`](https://www.pharosscan.xyz/tx/0x79d346c3beed0ca2b704cbb68ebbfaf3b761d329c9906bfaef74b23af77d45fe) | 22411143 | 75,623 | `receiveWithAuthorization` (`0xef55bec6`): AuthorizationUsed for the plan's nonce `0x734e0470…5c2c8`, then Transfer of 10000; `authorizationState` for that nonce now returns true |

Both were checked on chain afterwards (status 1, type 2, chain id 1672, from and to as prepared). The page's own
log line for both: "mined to/value/input match what knock handed to the wallet".

### 5. The run in the video

A Claude Code agent installed the skill from this repo and was asked, in plain words, for 0.01 USDC to myself by
signature. It ran `knock pay`, started the page with `knock sign --detach`, gave me the link in the chat and
stopped; I signed in my wallet ("Pay by signature"), said "done", and it ran `knock signed`:

```text
recheck (signature): OK - checked again at block 22413291: still goes through
claim prepared for 0x46441dc99f8000959e9c48Cf2A01a018D131D3Bb, gas 103090
tx 0xfb883c8bd2600a9ab9d7f5c600c62d6c31149063e09d2b1173c1dd8bff7c47c1: success in block 22413311, gas used 75643; mined to/value/input match what knock handed to the wallet
```

[`0xfb883c8b…47c1`](https://www.pharosscan.xyz/tx/0xfb883c8bd2600a9ab9d7f5c600c62d6c31149063e09d2b1173c1dd8bff7c47c1),
read back from `rpc.pharos.xyz`: status 1, from the wallet to USDC, AuthorizationUsed with the plan's nonce
`0x91f4…ccd9`, then Transfer of 10000 (0.01 USDC) to the same wallet.
