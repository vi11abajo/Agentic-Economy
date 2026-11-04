# 16 · Policy Gatekeeper

**bouncer** is an agent skill that stands in front of every on-chain action on Pharos mainnet and checks it
against the user's policy before anything can be signed: allowed hours, which contracts it may touch, who may
receive money, approvals, and spend caps per transaction and per day. Every request gets ALLOW or DENY with the
rule that decided, a denied request never reaches the key, and every decision lands in an audit log that shows
if anyone edits it.

What's different: bouncer doesn't judge the request by what it says, it judges the transaction by what it would
do. Each request is run through `debug_traceCall` on mainnet first, and the rules read the trace.

How it works, piece by piece: [ARCHITECTURE.md](ARCHITECTURE.md). Design notes:
[docs/superpowers/specs/2026-11-04-bouncer-design.md](../docs/superpowers/specs/2026-11-04-bouncer-design.md).

## Why the trace and not the request

Say the policy allows one contract, the pMusk market on Prosper (`0x5c3e…8b7f`), and the agent asks to buy
pMusk for 0.001 PROS. Judged by the request, that's a call to an allowed contract: let it through. The trace on
mainnet (block 22111392, 2026-11-04) shows what the call really does:

```
wallet -> 0x5c3e0e4b…8b7f  buyNative, 0.001 PROS            (the market)
            -> 0x30bebe43…bb56                               (called first)
            => DELEGATECALL (Pharos shows the market again as `to`)
                 -> 0x3c22060c…1bdb
                 -> WPROS 0x52c48d42…f0b0  with the 0.001 PROS (Deposit log)
                 -> pMusk 0xe318ac41…a7f8  (Transfer log)
```

Four more contracts nobody named. bouncer stops it:

```
DENY by contracts: 0x30bebe432ff53c9b6ed28dd9daf125902cbabb56 isn't on the contracts list; the transaction
reaches it at depth 1: wallet -> 0x5c3e…8b7f -> 0x30be…bb56
  judged on mainnet block 22111392
  ✓ time_window   no window set
  ✓ simulation    runs fine on mainnet state; gas up to 0.00370994 PROS
  ✗ contracts     0x30bebe432ff53c9b6ed28dd9daf125902cbabb56 isn't on the contracts list; ...
```

After the user looked at those four and added them, the same buy passed all seven rules (block 22111409).

The same idea runs through every rule: PROS is counted from every call the wallet makes with value, tokens from
every ERC-20, ERC-721 and ERC-1155 transfer out of the wallet (an NFT counts as 1), approvals from Approval and ApprovalForAll logs. A contract that "just
swaps" but also approves something, or sends a token somewhere else, can't hide it.

## The rules

Checked in this order; the first one that fails decides.

| Rule | Reads | Says no when |
|---|---|---|
| `time_window` | the clock | outside the allowed days and hours (UTC; 22:00-02:00 belongs to the day it opens) |
| `simulation` | the trace, balance, gas | the tx would fail anyway, or the wallet can't cover value + worst-case gas |
| `contracts` | every CALL / CREATE in the trace, any depth | a contract it touches isn't listed, or it creates a new one |
| `recipients` | PROS sent to plain wallets, ERC-20 / ERC-721 / ERC-1155 transfers out of the wallet | the receiver isn't the wallet, a listed recipient or a listed contract |
| `approvals` | Approval / ApprovalForAll logs from the wallet | the spender isn't listed, or the approval is unlimited and the policy says no |
| `spend.per_tx` | PROS and tokens leaving the wallet | over the cap, or the asset has no cap at all |
| `spend.per_day` | the audit log's last 24 hours + this one | over the daily cap, or the log is broken (then nobody knows what was spent) |

`policy` is the answer when the policy file is broken or the key in `.env` belongs to another wallet: everything
is denied until it's fixed.

Two Pharos details we found while building it (mainnet, 2026-11-04): a DELEGATECALL frame shows the proxy itself
as `to` and repeats the parent's `value`, so bouncer skips those frames when counting PROS (or the buy above would
count 0.002). And `eth_estimateGas` for a value the wallet can't cover answers "does not have enough funds"
instead of a revert; bouncer reads it as "this tx can't pass", not as a broken node.

## The policy file

`policy.json` in the data folder. A plain JSON file the user can read and edit; every edit is checked in full
and a broken file refuses to load. Example ([policy.example.json](policy.example.json)):

```json
{
  "name": "my agent's wallet rules",
  "wallet": "0x...",
  "time_window": { "days": ["mon", "tue", "wed", "thu", "fri"], "from": "08:00", "to": "20:00", "tz": "UTC" },
  "contracts": [],
  "recipients": [],
  "approvals": { "spenders": [], "unlimited": false },
  "spend": { "PROS": { "per_tx": "0.005", "per_day": "0.01" } }
}
```

A token gets its own entry with its address and decimals, e.g.
`"USDC": { "token": "0xC879C018dB60520F4355C26eD1a6D572cdAC1815", "decimals": 6, "per_tx": "1", "per_day": "2" }`.

## The audit log

`audit.jsonl` next to the policy, one line per decision, send and receipt: the request, the exact unsigned tx,
the hash of the policy file that judged it, every check, the decision. Each line carries the hash of the line
before it and its own, so `bouncer log --verify` names the first line that was edited, removed or reordered.
It's tamper-evident, not tamper-proof: someone can rewrite the whole file, but not quietly change one decision.
On a send, the tx hash is written before broadcasting, and a send with no receipt yet still counts against the
daily cap.

## Quick start

Node 20+. From this folder:

```bash
npm install
```

```bash
npm run build
```

That also writes the one-file bundle `skill/bouncer/scripts/bouncer.mjs`. Install the skill for your agent by
copying `skill/bouncer` into its skills folder, then ask in plain words ("can you buy pMusk for 0.001 PROS?").
Or run it yourself:

```bash
node skill/bouncer/scripts/bouncer.mjs policy init --wallet 0xYourWallet
```

```bash
node skill/bouncer/scripts/bouncer.mjs check pros 0x000000000000000000000000000000000000dEaD 0.001
```

`check` needs no key. `send` needs `PRIVATE_KEY=0x...` in `.env` in the data folder (`bouncer setup` prints
where), written by the user, never passed on the command line.

## Limits

- It gates what goes through bouncer. A transaction signed somewhere else never meets it.
- `recipients` checks who gets money straight from the wallet. A listed contract that takes a recipient argument
  (a router's swap `to`, a withdraw `receiver`) can still pay the output to someone else, so list only contracts
  you trust with that; the spend caps still limit what goes in.
- Caps are per asset in its own units, no dollar prices. Gas isn't counted in the caps; it's shown on every
  decision and the `simulation` rule makes sure the wallet can pay it.
- Permit2 and off-chain permit signatures aren't checked yet.
- Time windows are UTC only.
- Mainnet only (chain 1672).

## Tests

```bash
npm test
```

97 tests. The chain-facing ones replay four real mainnet traces recorded by `test/record.mjs` (a pMusk buy, a
PROS send, an unlimited USDC approval to the Prosper router, a buy bigger than the wallet), so they run offline
against what Pharos really answered.

## Proof

Filled in after the live run.
