---
name: knock
description: >
  knock: turns a payment in plain words ("send 100 USDC to alice.eth", "pay 0.5 PROS to 0x...", "move 0.01 USDC
  to myself") into a checked, human-readable summary and an unsigned transaction or wallet signing request on
  Pharos mainnet. It asks a follow-up whenever the sentence would need a guess (missing token, "$5", "1,000",
  two payments at once). Before anything is prepared it knocks on the recipient's address: .eth names are
  resolved on Ethereum (Pharos has no name service) and the address is compared on both chains, so a Safe that
  exists on Ethereum but was never deployed on Pharos is stopped; contract recipients, EIP-7702 delegated
  wallets, publicly known test keys and never-used addresses are flagged; the exact transfer is simulated from
  the sender to say what the money does on arrival (PROS sent to WPROS comes back as WPROS, USDC sent to the
  USDC contract is refused). Checks token contract, decimals and balance including gas. For USDC it can also
  prepare an EIP-3009 ReceiveWithAuthorization signature that only the payee can submit. knock holds no key and
  never signs or sends; a local page hands the payment to the user's own browser wallet. Use when someone wants
  to send or pay tokens on Pharos, or asks whether an address or .eth name is safe to pay.
version: 1.0.0
requires:
  anyBins:
  - node
---

# knock

Run with Node 20+: `node scripts/knock.mjs <command>` (use the absolute path of `scripts/knock.mjs` from
elsewhere). One bundled file, no install, no keys. Reads Pharos through https://rpc.pharos.xyz
(`PHAROS_RPC_URL` overrides it) and, only for .eth names, Ethereum through https://ethereum-rpc.publicnode.com
(`ETHEREUM_RPC_URL`).

## Commands

- `knock pay "<the user's sentence>" --from <their 0x address> [--answer "<their answer>"]... [--out file]`
  - exit 2: knock needs something first. Relay its question(s) to the user word for word and wait. Run the
    same command again with each answer added as `--answer "..."`. Never answer a question yourself, never
    pick a token, an amount or an address the user didn't say.
  - exit 3: knock stopped the payment. Tell the user the STOP line(s) in plain words and what they can do
    (for a name: ask the person for an address they use on Pharos).
  - exit 0: a plan. Show the user the summary block as it is (it comes before the JSON), including every
    `warn` line, and say where the plan file was saved. Mention the pay-by-signature option when it is offered.
  - If you don't know the user's address, ask for it. Only the public address: never ask for a key or a seed.
- `knock who <name.eth | 0x address>`: only the recipient check, on Ethereum and Pharos.
- `knock sign <plan file> --detach [--port 8643]`: starts a page on http://127.0.0.1:8643/ on its own and
  returns at once. Then reply to the user and end your turn: say you prepared a local signing page, that they
  sign it themselves in their own wallet (knock and you hold no key), give the link, and tell them which button
  matches what they asked for ("Send transfer" or "Pay by signature"). Say what the page does: it checks the
  payment again against the live chain before the wallet pops up, refuses another account or another chain,
  and after the block compares the mined tx with what knock prepared. Ask them to tell you when they're done.
- `knock signed <plan file> [--wait 300]`: when the user says they signed, this prints what the page saw
  (refused connects, the tx line with status, block, gas, and whether the mined input matches). Exit 0 mined
  and matching, 3 mined but not matching or failed, 2 not mined yet or the page closed after 30 minutes unused.
  Report the tx hash and the match line as printed.
  - Without --detach the page runs until Ctrl+C (`--until-mined` stops it after the block).
  - Paying someone else by signature: the page downloads `knock-authorization.json`; the payee opens it with
    `knock sign knock-authorization.json` and submits it from their own wallet (only the payee can).

## Rules

- knock never signs or sends, and neither do you: no keys, no `cast send`, no raw transactions. The user's
  wallet signs on the page.
- Show what knock printed; don't soften a STOP or drop a warn line.
- A plan is a snapshot of one block. If time has passed, the page re-checks anyway; for a new amount or
  recipient run `knock pay` again.
