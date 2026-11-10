# rapsheet: 0x19d2…466e is HIGH risk

[0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e), wallet. Pharos mainnet, head block 22696169, 2026-11-10 23:11 UTC.

## Red flags

1. **HIGH**: 1 other wallet gave this plain wallet the right to move their tokens, and it is still open: 0xa95f…d91b on token 0xc879…1815. Seen in the last 100000 blocks (about 26 hours). Apps take approvals through contracts. A bare wallet collecting other people's approvals can pull their tokens whenever it likes: that's how approval drainers get paid.
2. **MEDIUM**: It has no history at all: the explorer has never seen a transaction to or from it. An address nobody has used gives you nothing to go on. If someone asked you to pay it, check it really is theirs.

## The whole record

| | Check | What we saw | Evidence |
|---|---|---|---|
| note | What it is | A plain wallet: someone's private key, no code. | [0x19d2…466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e) (read from the chain) |
| HIGH | Who lets it move their tokens | 1 other wallet gave this plain wallet the right to move their tokens, and it is still open: 0xa95f…d91b on token 0xc879…1815. Seen in the last 100000 blocks (about 26 hours). | [approval 0xc76f…2cec](https://www.pharosscan.xyz/tx/0xc76fd41aa7c2de16c20afae1a13360102db155406176b4b21337f506e9272cec), [owner 0xa95f…d91b](https://www.pharosscan.xyz/address/0xa95f856f2835ae2a61b2360b3de4f0ff2b39d91b) (read from the chain) |
| MEDIUM | How long the wallet has existed | It has no history at all: the explorer has never seen a transaction to or from it. | [0x19d2…466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e) (from the explorer) |
| ok | Approvals it left open | It has never sent an approve transaction that the explorer lists. | [0x19d2…466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e) (explorer, checked on the chain) |
| not checked | Who paid for its first gas | The explorer doesn't show who first funded this wallet. | [0x19d2…466e](https://www.pharosscan.xyz/address/0x19d2ed9bc8d3f83f86fe30a017abb55e6a85466e) (from the explorer) |

One HIGH flag or three MEDIUM flags make it HIGH; one or two MEDIUM make it MEDIUM. Red flags are reasons to stop and look, not proof of a crime.
