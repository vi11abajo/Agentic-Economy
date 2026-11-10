# rapsheet: 0xc879…1815 is MEDIUM risk

[0xc879c018db60520f4355c26ed1a6d572cdac1815](https://www.pharosscan.xyz/address/0xc879c018db60520f4355c26ed1a6d572cdac1815), contract "FiatTokenV2_2". Pharos mainnet, head block 22696231, 2026-11-10 23:12 UTC.

## Red flags

1. **MEDIUM**: Yes, by one private key: it is a proxy running 0xc35b…eae8, and its proxy admin is a plain wallet, 0x46f9…3f1b. Whoever holds that one key can swap the code at any moment, without asking anyone, including for code that drains what you approved.

## The whole record

| | Check | What we saw | Evidence |
|---|---|---|---|
| note | What it is | A contract the explorer calls FiatTokenV2_2. | [0xc879…1815](https://www.pharosscan.xyz/address/0xc879c018db60520f4355c26ed1a6d572cdac1815) (read from the chain) |
| MEDIUM | Can its code be swapped | Yes, by one private key: it is a proxy running 0xc35b…eae8, and its proxy admin is a plain wallet, 0x46f9…3f1b. | [proxy admin 0x46f9…3f1b](https://www.pharosscan.xyz/address/0x46f958bdeffd33495e058873cdd114c79ec13f1b), [implementation 0xc35b…eae8](https://www.pharosscan.xyz/address/0xc35becb283fec66626220467265f6d3b3f8ceae8) (read from the chain) |
| note | Who has approved it | Nobody approved it to move their tokens in the last 100000 blocks (about 26 hours). |  (read from the chain) |
| note | What its owner can do | Its bytecode has functions to create new tokens out of nothing (mint); freeze all transfers (pause); block particular addresses from moving their tokens (blacklist). | [0xc35b…eae8 code](https://www.pharosscan.xyz/address/0xc35becb283fec66626220467265f6d3b3f8ceae8) (read from the chain) |
| note | Have you dealt with it before | Yes: it appears 38 times in your history, the last time 6 hours ago. | [tx 0x9ae6…1f7d](https://www.pharosscan.xyz/tx/0x9ae64ca6c05fc23fce815791adad2ccd014682cb46215fdeea61a2e15a7a1f7d) (from your own history) |
| ok | How old the contract is | It was created 8 months ago, in block 4035507 (the chain has no code at this address one block earlier). | [creation tx 0xe2cc…7d1b](https://www.pharosscan.xyz/tx/0xe2ccd8054a290f5e5be6ecbf99ec8480df017f27d6516a373b39bd81cb2d7d1b), [block 4035507](https://www.pharosscan.xyz/block/4035507) (explorer, checked on the chain) |
| ok | Can anyone read the code | The source of the code behind this proxy (0xc35b…eae8) is published and verified on pharosscan. | [0xc35b…eae8 code](https://www.pharosscan.xyz/address/0xc35becb283fec66626220467265f6d3b3f8ceae8) (from the explorer) |
| ok | Has its code been swapped | No: the same implementation has been in place since the contract was created (block 4035507). | [block 4035507](https://www.pharosscan.xyz/block/4035507) (read from the chain) |
| ok | Does it imitate someone you pay | No: none of the 52 addresses you've paid shares its first and last four characters. | [your history](https://www.pharosscan.xyz/address/0x46441dc99f8000959e9c48cf2a01a018d131d3bb) (from your own history) |

One HIGH flag or three MEDIUM flags make it HIGH; one or two MEDIUM make it MEDIUM. Red flags are reasons to stop and look, not proof of a crime.
