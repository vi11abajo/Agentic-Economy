# What the two wallets actually touched (probed 2026-11-05)

Probes were plain `eth_call`s on Pharos mainnet (rpc.pharos.xyz and the Chain MCP) at blocks around 22,204,2xx,
plus a few historical blocks. Method names come from api.openchain.xyz where it knew the selector.

Wallets:
- A = `0x9f857e7894e34d1cd09e55a8a27a8742729ea37c` (the user's example): 351 of 352 txs, 279 of 281 token
  transfers served by the explorer. Holds today: 1.3176 PROS, 1.514741 USDC, 0.00276 BANANA.
- T = `0x46441dc99f8000959e9c48cf2a01a018d131d3bb` (our test wallet): 833 of 859 txs, 295 of 334 transfers served.
  Holds today: 0.0142 PROS, 0.49979 USDC, 1 pTACO, 1 pCARR, 1385.68 pMusk.

The explorer serves fewer rows than its own `total` on both wallets, yet for every token the sum of the served
transfers in minus out equals the `balanceOf` at the pinned block. So completeness is checked per token against
the chain, not against the explorer's total.

## Prices

| Source | Address | Call | Notes |
|---|---|---|---|
| Chainlink PROS/USD | `0x371Ed36aEe5bFFbED1A2aa9b7deD7F4EB30F5466` | `latestRoundData()`, `decimals()` = 18 | works at past blocks: 0.5190 now, 0.6334 at 20,700,000, 0.5353 at 18,000,000 |
| Faroswap V3 WPROS/USDC fee100 | `0x912c9ade24d44d8922f0866d8dcb079f1363f647` | `slot0()`, token0 = WPROS | agrees with the feed: 0.5198 / 0.6327 / 0.5354 at the same blocks |

USDC counts as 1. WPROS and native PROS use the feed.

## Tokens and how to price them

| What | Example | How to recognise | How to price |
|---|---|---|---|
| Prosper V2 pair token (graduated) | pTACO `0x52ac...2db5`, pair `0xAf2b...E7B8`; pCARR `0xd6d6...18c5`, pair `0x3fa4...e558` | factory `0x9343D6F1a7058a9ffD43028666dB23CFcE3E0D1e` `allPairs(i)` (10 pairs, all vs WPROS) | pair `getReserves()` -> WPROS per token -> feed |
| Prosper curve token | pMusk `0xe318...a7f8`, market `0x5c3e0e4b1be0851dcbc5f6a5cc04d799acbe8b7f` | the market is the sender of the pToken in a buy receipt (event `0x2683a506` Bought); market `pToken()` returns the token; `phase()` = 3 here | market `quoteSell(amount)` -> net WPROS (1385 pMusk -> 0.01044 WPROS) -> feed |
| ERC-4626 vault share | stPROS `0x6b0a...5ec4` "Faroo Staked PROS", asset WPROS, 1 share = 1.0067 WPROS; FRHV001 `0x36f3...e6` "Faroo RWA Hybrid Vault 001", asset stPROS, 24 decimals, 1 share = 1.0329 stPROS | `asset()` + `convertToAssets()` answer and the token itself is the vault | `convertToAssets(balance)` -> price of the asset (recursive) |
| ERC-7540 share token (separate from the vault) | PROPRO via vault `0x8293...b54a`, DOGV `0x6496...da38`, BANANA `0x2f1c...4e75`, ATV915 `0xb04c...859b`, EMST `0xbf82...0184`, GFELG `0x45c8...e2df`, CRS `0x49d7...eb27`, csvtd `0xde4b...f143`, EMHT `0x5fe7...3219`, Axil Pot share `0x1328...b0F8` via `0x9219...ea6b` | the wallet called `requestRedeem`/`requestDeposit`/`deposit` on a vault whose `share()` is this token; all have asset USDC | vault `convertToAssets(balance)` in USDC |
| SharpByte VaultV2 | sbUSDC-ph-eco `0x15c2...aff1` | ERC-4626 shape, asset USDC | `convertToAssets` |
| Plain token with no route | APT, others | nothing above matches | `no-price-route` naming what was tried |

## Contracts the wallets called

| Contract | Calls | What it is |
|---|---|---|
| `0x63ff...22f5` | `0x6b8eaf6d` x56, `0xfddc508e` x23 (A) | Prosper curve router (buy/sell on the curve) |
| `0xa5ca...f75c` | `mixSwap` x33 (A), x177 (T) | swap aggregator route proxy |
| `0x974d...9f35` | `dagSwapTo` x18 (A) | swap aggregator |
| `0x36c8...1fec` | `callDiamondWithPermit2` x18 (A) | diamond proxy, answers no standard getters |
| `0xbbdd...ec6ec` | `requestDeposit(address,uint256)` x16 (A) | answers no standard getter (no name, asset, share): no adapter |
| `0x1584...7811`, `0x707e...9325` | `claim(address,address,uint256,bytes32[])` | Merkle distributors: tokens arrive with nothing paid (received, not bought) |
| `0xff70...04b2` | LiFi `swapAndStartBridgeTokensViaLiFiIntentEscrowV2` | bridge out |
| `0x14f0...9d0a` | `0x8c005948` (T, pTACO buy with 0.00886 PROS) | Prosper V2 router |
| `0x1857...4efb` | Morpho Blue (T) | Morpho: `position(id, wallet)` per market the wallet touched |
| `0x75f2...8dea` | `0xf2c42696` (A) | answers no standard getter: no adapter |

## Shapes of real transactions (for classifying incoming tokens)

- pTACO buy on T: tx from T to the V2 router with 0.00886 native PROS; pTACO arrives from the pair. Paid -> bought.
- pCARR on T: a swap sent by ANOTHER wallet through the pair with T as recipient; T paid nothing in that tx -> received.
- pTACO on A via `claim` on `0x1584...`: arrives from the distributor, nothing paid -> received.
- stPROS sell on A through `mixSwap`: stPROS out, the router unwraps WPROS (`Withdrawal` event) and pays native PROS
  by an internal call (no Transfer log): the native leg is the explorer's internal transaction, matched to the
  receipt's WPROS `Withdrawal` amount.
- Axil Pot `requestRedeem` on T (block 21,844,804): share tokens burned, event `0x1fdc681a` on the vault with
  owner and shares in data; ids are per-request (task 11: id 18).
