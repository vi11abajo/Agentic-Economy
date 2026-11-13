// Everything one wallet holds across Prosper, in one read at one block: the pToken of every market and the share
// token of every vault. For pTokens still on the curve, what a full sell would pay right now; for vault shares, what
// they are worth at the vault's own share price (convertToAssets). Before this, the agent called `position` forty
// times in a row to answer "what do I hold".
import { erc20Abi, getAddress, parseAbi, type Address } from "viem";
import { client } from "./chain.js";
import { PHASE } from "./board.js";
import type { VaultListing } from "./prosperApi.js";

const marketAbi = parseAbi([
  "function phase() view returns (uint8)",
  "function quoteSell(uint256) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
]);
const vaultAbi = parseAbi(["function convertToAssets(uint256) view returns (uint256)"]);

export interface Holding {
  kind: "pToken" | "vault shares";
  symbol: string;
  vaultName: string;
  token: Address;
  market: Address;
  vault: Address;
  balance: bigint;
  phase?: string;
  /** pToken on the curve: net PROS a full sell pays now */
  sellNetPros?: bigint | null;
  /** vault shares: USDC (6 decimals) at the vault's share price */
  valueUsdc?: bigint;
}

export async function readPortfolio(owner: Address, rows: VaultListing[]) {
  const block = await client.getBlockNumber({ cacheTime: 0 });
  const bal = await client.multicall({
    blockNumber: block, allowFailure: true,
    contracts: rows.flatMap((r) => [r.pToken, r.share].map((t) => ({ address: t, abi: erc20Abi, functionName: "balanceOf" as const, args: [owner] as const }))),
  });
  const holdings: Holding[] = [];
  for (const [i, r] of rows.entries()) {
    const base = { symbol: r.pVaultSymbol, vaultName: r.vaultName, market: getAddress(r.market), vault: getAddress(r.r25Vault) };
    const p = bal[i * 2], s = bal[i * 2 + 1];
    if (p.status === "success" && (p.result as bigint) > 0n) holdings.push({ ...base, kind: "pToken", token: getAddress(r.pToken), balance: p.result as bigint });
    if (s.status === "success" && (s.result as bigint) > 0n) holdings.push({ ...base, kind: "vault shares", token: getAddress(r.share), balance: s.result as bigint });
  }
  // second round only for what the wallet actually holds
  for (const h of holdings) {
    if (h.kind === "pToken") {
      const phase = Number(await client.readContract({ address: h.market, abi: marketAbi, functionName: "phase", blockNumber: block }));
      h.phase = PHASE[phase] ?? `phase ${phase}`;
      h.sellNetPros = phase === 0
        ? (await client.readContract({ address: h.market, abi: marketAbi, functionName: "quoteSell", args: [h.balance], blockNumber: block }))[2]
        : null;
    } else {
      h.valueUsdc = await client.readContract({ address: h.vault, abi: vaultAbi, functionName: "convertToAssets", args: [h.balance], blockNumber: block });
    }
  }
  return {
    owner, block, checkedMarkets: rows.length, holdings,
    note: holdings.length ? "pToken sellNetPros is null after graduation: those trade on FaroSwap." : "No Prosper pToken or vault shares in this wallet at this block.",
  };
}
