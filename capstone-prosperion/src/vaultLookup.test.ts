import { test } from "node:test";
import assert from "node:assert/strict";
import { findVault } from "./vaultLookup.js";
import type { VaultListing } from "./prosperApi.js";

// Two real rows from Prosper's listing (Barker, Bot) and a made-up second Barker to make names ambiguous.
const row = (vaultName: string, pVaultSymbol: string, r25Vault: string, share: string, market: string, pToken: string): VaultListing =>
  ({ vaultName, pVaultSymbol, r25Vault, share, market, pToken, status: "LINKED", createdAt: "" }) as VaultListing;
const LIST = [
  row("Barker Neutral Carry", "pCARR", "0x3ed49843a55952a399db99c8949f67a9d821611c", "0x2d3f6cbb1662b87f2ea998a58c194ff20e1c9a68",
    "0x0c1af274f8802f6d58e854d56ed6cf905407bff7", "0xd6d6c5b012a81d793dead821d1dd05446e1118c5"),
  row("Barker Stable Income", "ppSAV", "0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
    "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"),
  row("Bot", "pBOT", "0x5555555555555555555555555555555555555555", "0x6666666666666666666666666666666666666666",
    "0x7777777777777777777777777777777777777777", "0x8888888888888888888888888888888888888888"),
];
const BARKER = "0x3Ed49843a55952A399dB99C8949f67a9D821611C";

test("a vault's name, in any case, finds its vault address", () => {
  assert.deepEqual(findVault("barker neutral carry", LIST), { vault: BARKER, name: "Barker Neutral Carry", known: true });
  assert.equal(findVault("pCARR", LIST).vault, BARKER);
});

test("the share token, market or pToken of a vault lead to the vault itself", () => {
  for (const a of ["0x2D3f6CbB1662B87f2ea998a58c194Ff20e1C9a68", "0x0c1af274f8802f6d58e854d56ed6cf905407bff7", "0xd6d6c5b012a81d793dead821d1dd05446e1118c5"])
    assert.equal(findVault(a, LIST).vault, BARKER);
});

test("a name that fits several vaults asks which one and lists them", () => {
  assert.throws(() => findVault("barker", LIST), (e: Error) => /Barker Neutral Carry/.test(e.message) && /Barker Stable Income/.test(e.message));
});

test("a name that fits nothing points at list_vaults", () => {
  assert.throws(() => findVault("Moon Vault", LIST), /list_vaults/);
});

test("an address the listing does not know is passed through, marked unknown", () => {
  assert.deepEqual(findVault("0x8e634f8af1cca10cacb85c23fedd6171a31f7997", LIST),
    { vault: "0x8E634F8AF1cCa10cAcb85c23FEdD6171a31F7997", name: null, known: false });
});
