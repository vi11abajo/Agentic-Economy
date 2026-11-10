// What the code lets its owner do, read straight from the bytecode. A Solidity contract checks the first 4 bytes of
// the calldata against each function it has, and those 4-byte selectors sit in the code as PUSH4 constants. So
// "does this token have a blacklist?" can be answered without the source: look for blacklist's selector.
// It's a hint, not a proof: a function can exist under another name, and a selector can match by accident.
import { toFunctionSelector } from "viem";
import type { Hex } from "./explorer.js";

export interface Power {
  /** What it means for you, in words. */
  power: string;
  signatures: string[];
}

export const POWERS: Power[] = [
  { power: "create new tokens out of nothing (mint)", signatures: ["mint(address,uint256)", "mint(uint256)", "mintTo(address,uint256)"] },
  { power: "freeze all transfers (pause)", signatures: ["pause()", "setPaused(bool)"] },
  {
    power: "block particular addresses from moving their tokens (blacklist)",
    signatures: ["blacklist(address)", "addBlackList(address)", "addToBlacklist(address)", "setBlacklist(address,bool)", "blockAddress(address)", "setBlacklisted(address,bool)"],
  },
  {
    power: "change the fee or tax taken on every transfer",
    signatures: ["setFee(uint256)", "setFees(uint256,uint256)", "setTaxFee(uint256)", "setBuyTax(uint256)", "setSellTax(uint256)", "setTaxes(uint256,uint256)", "updateFees(uint256,uint256)"],
  },
  { power: "cap how much one address may move or hold", signatures: ["setMaxTxAmount(uint256)", "setMaxWalletSize(uint256)", "setMaxWallet(uint256)"] },
  { power: "swap in different code (upgrade)", signatures: ["upgradeTo(address)", "upgradeToAndCall(address,bytes)"] },
  { power: "pull any token out of the contract", signatures: ["withdrawToken(address,uint256)", "rescueTokens(address,address,uint256)", "emergencyWithdraw(address)", "sweep(address)"] },
];

/** Every 4-byte constant pushed by the code, skipping over the data of other PUSH instructions. */
export function push4s(code: Hex): Set<string> {
  const bytes = code.slice(2);
  const out = new Set<string>();
  for (let i = 0; i < bytes.length; i += 2) {
    const op = parseInt(bytes.slice(i, i + 2), 16);
    if (op >= 0x60 && op <= 0x7f) {
      const n = op - 0x5f;
      if (op === 0x63) out.add(`0x${bytes.slice(i + 2, i + 10)}`);
      i += n * 2;
    }
  }
  return out;
}

export interface FoundPower {
  power: string;
  matched: string[];
}

export function powersIn(code: Hex): FoundPower[] {
  const have = push4s(code);
  const found: FoundPower[] = [];
  for (const p of POWERS) {
    const matched = p.signatures.filter((s) => have.has(toFunctionSelector(`function ${s}`)));
    if (matched.length > 0) found.push({ power: p.power, matched });
  }
  return found;
}
