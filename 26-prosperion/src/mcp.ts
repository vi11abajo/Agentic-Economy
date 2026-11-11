// Prosperion's own MCP server: the agent's only way to get Prosper numbers. Everything here is a read, and every
// answer carries the block it was read at, so the agent can quote the block and cross-check it through the Pharos
// Chain MCP at that same block. No tool here can build, sign or send a transaction.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAddress, isAddress, parseEther, type Address } from "viem";
import { z } from "zod";
import { checkMarket } from "./market.js";
import { MAX_SPAN, explainNavMove } from "./navmove.js";
import { readPosition } from "./position.js";
import { loadProtocol } from "./protocol.js";
import { listVaults } from "./prosperApi.js";
import { rewardUnlock } from "./rewards.js";
import { readVault } from "./vault.js";

export interface LaunchRow {
  market: Address;
  vault: Address;
  pToken: Address;
  block: bigint;
  tx: string;
}
export interface McpDeps {
  listLaunches: (limit: number) => LaunchRow[];
}

const addr = z.string().refine(isAddress, "not an address").describe("0x address");
const blockArg = z.string().regex(/^\d+$/).describe("block number");

// bigints go out as decimal strings so nothing loses precision on the way to the model
const json = (x: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});

export function createProsperionMcp(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "prosperion", version: "1.0.0" });

  server.registerTool(
    "list_vaults",
    { title: "List Prosper vaults", description: "All Prosper vaults with their R25 vault, market and pToken addresses. Names come from Prosper's API; check numbers with vault_picture." },
    async () =>
      json((await listVaults()).map((v) => ({
        name: v.vaultName, symbol: v.pVaultSymbol, vault: v.r25Vault, market: v.market, pToken: v.pToken, status: v.status, createdAt: v.createdAt,
      }))),
  );

  server.registerTool(
    "vault_picture",
    {
      title: "What is behind a vault's NAV",
      description: "Splits a vault's NAV into USDC and tokens in its escrow on Pharos, Local adapters (on Pharos) and Mirror adapters (a value the operator reports from another chain). verifiableBps = share you can check on Pharos. reconciles = our sum equals the oracle's NAV.",
      inputSchema: { vault: addr, block: blockArg.optional() },
    },
    async (a) => json(await readVault(getAddress(a.vault), a.block ? BigInt(a.block) : undefined)),
  );

  server.registerTool(
    "nav_move",
    {
      title: "Why NAV per share moved",
      description: `Explains a NAV-per-share move between two blocks (at most ${MAX_SPAN} apart): flows (settled deposits/redeems), admin (shares burned with no money moving), fees (shares minted with no money moving), mirror (operator-reported value change), price (the rest). usdc parts have 6 decimals, shares parts 18.`,
      inputSchema: { vault: addr, fromBlock: blockArg, toBlock: blockArg },
    },
    async (a) => json(await explainNavMove(getAddress(a.vault), BigInt(a.fromBlock), BigInt(a.toBlock))),
  );

  server.registerTool(
    "oracle_freshness",
    { title: "How old the vault's prices are", description: "Age of every price the vault's NAV uses, and whether the oracle itself calls the NAV valid.", inputSchema: { vault: addr } },
    async (a) => {
      const v = await readVault(getAddress(a.vault));
      return json({ vault: v.vault, block: v.block, validNav: v.validNav, prices: v.prices });
    },
  );

  server.registerTool(
    "market_check",
    {
      title: "Is this a real Prosper market, can I still be first",
      description: "Checks a market against Prosper's factory, reads its phase (0 on curve, 2 graduated, 3 failed), PROS already in the curve (0 = nobody bought yet), the market code it runs now, and quotes a buy.",
      inputSchema: { market: addr, amountIn: z.string().regex(/^\d+(\.\d+)?$/).describe("PROS to spend, e.g. \"1.5\"") },
    },
    async (a) => json(await checkMarket(getAddress(a.market), parseEther(a.amountIn))),
  );

  server.registerTool(
    "recent_launches",
    {
      title: "Recent Prosper launches",
      description: "Markets Prosperion's watcher saw being created, newest first. Run market_check on one before saying anything about it.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async (a) => json(deps.listLaunches(a.limit ?? 10)),
  );

  server.registerTool(
    "protocol_map",
    { title: "Prosper contract map", description: "Prosper's contract addresses from its API, each checked against the chain (factory pinned, beacon matched against a real market, code present)." },
    async () => json(await loadProtocol()),
  );

  server.registerTool(
    "reward_unlock",
    {
      title: "Early depositor reward unlock",
      description: "Unlock table and current step for a vault's early depositor reward. hypothesis=true: the table is Prosper's API, the formula and its 7-day median are not on chain. NAV now is read on chain.",
      inputSchema: { vault: addr },
    },
    async (a) => json(await rewardUnlock(getAddress(a.vault))),
  );

  server.registerTool(
    "position",
    {
      title: "A wallet's position in one market",
      description: "pToken balance of a wallet in one Prosper market and the net PROS a full sell on the curve would return right now (null after graduation).",
      inputSchema: { owner: addr, market: addr },
    },
    async (a) => json(await readPosition(getAddress(a.owner), getAddress(a.market))),
  );

  return server;
}
