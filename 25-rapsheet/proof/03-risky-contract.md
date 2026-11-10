# rapsheet: 0x04a6…dc22 is HIGH risk

[0x04a6dd7907fff325c580dc84829f0379de49dc22](https://www.pharosscan.xyz/address/0x04a6dd7907fff325c580dc84829f0379de49dc22), contract. Pharos mainnet, head block 22696147, 2026-11-10 23:10 UTC.

## Red flags

1. **HIGH**: Yes: the code running today was put in 19 hours ago, in block 22622345, 20 days after the contract went live (pharosscan still shows the older 0xafbe…60ac; the chain says 0xc404…7e0e). The contract you'd be trusting changed this week, and nobody can read the new code. Whatever people trusted it for before doesn't carry over.
2. **MEDIUM**: The source of the code behind this proxy (0xc404…7e0e) is not verified: all anyone can see is bytecode. Unverified code is a black box. You'd be trusting it without anyone being able to check what it does with your tokens.
3. **MEDIUM**: Yes, by one private key: it is a proxy running 0xc404…7e0e, and its owner() is a plain wallet, 0x54f8…5ff4. Whoever holds that one key can swap the code at any moment, without asking anyone, including for code that drains what you approved.

## The whole record

| | Check | What we saw | Evidence |
|---|---|---|---|
| note | What it is | A contract with no name on the explorer. | [0x04a6…dc22](https://www.pharosscan.xyz/address/0x04a6dd7907fff325c580dc84829f0379de49dc22) (read from the chain) |
| HIGH | Has its code been swapped | Yes: the code running today was put in 19 hours ago, in block 22622345, 20 days after the contract went live (pharosscan still shows the older 0xafbe…60ac; the chain says 0xc404…7e0e). | [upgrade tx 0x0570…9558](https://www.pharosscan.xyz/tx/0x05708140b33ae9d712ab9920672db3f7b15497c12325be05a550cff12daa9558), [block 22622345](https://www.pharosscan.xyz/block/22622345) (read from the chain) |
| MEDIUM | Can anyone read the code | The source of the code behind this proxy (0xc404…7e0e) is not verified: all anyone can see is bytecode. | [0xc404…7e0e code](https://www.pharosscan.xyz/address/0xc404caf08732517ac9c0d4851e3d4336fb4e7e0e) (from the explorer) |
| MEDIUM | Can its code be swapped | Yes, by one private key: it is a proxy running 0xc404…7e0e, and its owner() is a plain wallet, 0x54f8…5ff4. | [owner() 0x54f8…5ff4](https://www.pharosscan.xyz/address/0x54f856b5837aad58267fa6c37f901fa79b465ff4), [implementation 0xc404…7e0e](https://www.pharosscan.xyz/address/0xc404caf08732517ac9c0d4851e3d4336fb4e7e0e) (read from the chain) |
| note | Who has approved it | In the last 100000 blocks (about 26 hours), 71 wallets approved it to move their tokens (109 approvals, 109 of them unlimited). | [approval 0xee9b…9ad6](https://www.pharosscan.xyz/tx/0xee9bfcf755b510c402c40458bc2575c62cc732fbca2e808bd75c76aaaf189ad6), [approval 0x657f…d9d1](https://www.pharosscan.xyz/tx/0x657f80c08913f35377248422e7e38c651d46deb5e1d898b92db4d700c5f5d9d1) (read from the chain) |
| note | What its owner can do | Its bytecode has functions to swap in different code (upgrade). | [0xc404…7e0e code](https://www.pharosscan.xyz/address/0xc404caf08732517ac9c0d4851e3d4336fb4e7e0e) (read from the chain) |
| ok | How old the contract is | It was created 21 days ago, in block 20817840 (the chain has no code at this address one block earlier). | [creation tx 0x1254…8892](https://www.pharosscan.xyz/tx/0x1254f0427806ffed0be3d2174b268794683ed5a75a8d1fbbe422726df0ab8892), [block 20817840](https://www.pharosscan.xyz/block/20817840) (explorer, checked on the chain) |

One HIGH flag or three MEDIUM flags make it HIGH; one or two MEDIUM make it MEDIUM. Red flags are reasons to stop and look, not proof of a crime.
