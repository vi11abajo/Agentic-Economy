// Prosperion's own MCP server: the agent's only way to get Prosper numbers. Everything here is a read, and every
// answer carries the block it was read at, so the agent can quote the block and cross-check it through the Pharos
// Chain MCP at that same block. No tool here can build, sign or send a transaction.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getAddress, isAddress, parseEther, toFunctionSelector, type Address } from "viem";
import { z } from "zod";
import { checkMarket } from "./market.js";
import { MAX_SPAN, explainNavMove } from "./navmove.js";
import { readPosition } from "./position.js";
import { loadProtocol } from "./protocol.js";
import { listVaults } from "./prosperApi.js";
import { rewardUnlock } from "./rewards.js";
import { readVault } from "./vault.js";
import { findVault } from "./vaultLookup.js";

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
const vaultArg = z.string().min(1)
  .describe('The vault: its name (e.g. "Barker Neutral Carry") or its vault, share token, market or pToken address');

// Prosper's listing changes when a vault launches, a few times a week at most; ten minutes is plenty fresh
// for turning names into addresses, and it saves a few seconds on every vault question.
let listing: { at: number; rows: Awaited<ReturnType<typeof listVaults>> } | null = null;
async function vaultRows() {
  if (!listing || Date.now() - listing.at > 10 * 60_000) listing = { at: Date.now(), rows: await listVaults() };
  return listing.rows;
}

// The model cannot hash, so it guessed totalAssets() as 0x01e8f265 and every cross-check reverted. We hand it
// the exact calls, at the same block, with the answer it should get back.
const crossCheck = (v: { vault: Address; block: bigint; totalAssets: bigint; supply: bigint }) => [
  { what: "vault totalAssets()", to: v.vault, data: toFunctionSelector("totalAssets()"), block: v.block, expect: v.totalAssets },
  { what: "vault totalSupply()", to: v.vault, data: toFunctionSelector("totalSupply()"), block: v.block, expect: v.supply },
];

/** Runs a vault read on whatever the agent passed, and says plainly what went wrong if it was not a vault. */
async function onVault<T>(input: string, read: (vault: Address) => Promise<T>): Promise<T> {
  let rows: Awaited<ReturnType<typeof listVaults>> = [];
  try { rows = await vaultRows(); }
  catch { if (!isAddress(input.trim())) throw new Error("Prosper's vault list did not load, so names do not work right now. Pass the vault address."); }
  const hit = findVault(input, rows);
  try {
    return await read(hit.vault);
  } catch (e) {
    if (hit.known) throw e;
    throw new Error(`${hit.vault} is not a Prosper vault: reading it as one failed. It may be a vault's escrow or adapter. ` +
      `Pass the vault's name (e.g. "Barker Neutral Carry") or call list_vaults with a query.`);
  }
}

// bigints go out as decimal strings so nothing loses precision on the way to the model
const json = (x: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(x, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2) }],
});

export function createProsperionMcp(deps: McpDeps): McpServer {
  const server = new McpServer({ name: "prosperion", version: "1.0.0" });

  server.registerTool(
    "list_vaults",
    {
      title: "List Prosper vaults",
      description: "Prosper vaults with their vault, share token, market and pToken addresses. Pass query to get only the ones whose name or symbol contains it. The vault tools also take a name directly. Names come from Prosper's API; check numbers with vault_picture.",
      inputSchema: { query: z.string().optional().describe("part of a vault name or symbol, e.g. \"barker\"") },
    },
    async (a) => {
      const q = a.query?.trim().toLowerCase();
      const rows = (await vaultRows()).filter((v) => !q || v.vaultName.toLowerCase().includes(q) || v.pVaultSymbol.toLowerCase().includes(q));
      return json(rows.map((v) => ({
        name: v.vaultName, symbol: v.pVaultSymbol, vault: v.r25Vault, share: v.share, market: v.market, pToken: v.pToken, status: v.status, createdAt: v.createdAt,
      })));
    },
  );

  server.registerTool(
    "vault_picture",
    {
      title: "What is behind a vault's NAV",
      description: "Splits a vault's NAV into USDC and tokens in its escrow on Pharos, Local adapters (on Pharos) and Mirror adapters (a value the operator reports from another chain). verifiableBps = share you can check on Pharos. reconciles = our sum equals the oracle's NAV. crossCheck = the exact pharos-chain eth_call (to, data, block) for totalAssets and totalSupply with the value it must return; copy it as is.",
      inputSchema: { vault: vaultArg, block: blockArg.optional() },
    },
    async (a) => {
      const v = await onVault(a.vault, (x) => readVault(x, a.block ? BigInt(a.block) : undefined));
      return json({ ...v, crossCheck: crossCheck(v) });
    },
  );

  server.registerTool(
    "nav_move",
    {
      title: "Why NAV per share moved",
      description: `Explains a NAV-per-share move between two blocks (at most ${MAX_SPAN} apart): flows (settled deposits/redeems), admin (shares burned with no money moving), fees (shares minted with no money moving), mirror (operator-reported value change), price (the rest). usdc parts have 6 decimals, shares parts 18.`,
      inputSchema: { vault: vaultArg, fromBlock: blockArg, toBlock: blockArg },
    },
    async (a) => json(await onVault(a.vault, (v) => explainNavMove(v, BigInt(a.fromBlock), BigInt(a.toBlock)))),
  );

  server.registerTool(
    "oracle_freshness",
    { title: "How old the vault's prices are", description: "Age of every price the vault's NAV uses, and whether the oracle itself calls the NAV valid.", inputSchema: { vault: vaultArg } },
    async (a) => {
      const v = await onVault(a.vault, (x) => readVault(x));
      return json({ vault: v.vault, block: v.block, validNav: v.validNav, prices: v.prices });
    },
  );

  server.registerTool(
    "market_check",
    {
      title: "Is this a real Prosper market, can I still be first",
      description: "Checks a market against Prosper's factory, reads its phase (0 on curve, 2 graduated, 3 failed), PROS already in the curve (0 = nobody bought yet), the market code it runs now, and quotes a buy. crossCheck = the exact pharos-chain eth_call for the reserve, with the value it must return; copy it as is.",
      inputSchema: { market: addr, amountIn: z.string().regex(/^\d+(\.\d+)?$/).describe("PROS to spend, e.g. \"1.5\"") },
    },
    async (a) => {
      const m = await checkMarket(getAddress(a.market), parseEther(a.amountIn));
      const crossCheck = [{ what: "market realWrappedNativeReserve()", to: m.market, data: toFunctionSelector("realWrappedNativeReserve()"), block: m.block, expect: m.reserveBefore }];
      return json({ ...m, crossCheck });
    },
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
      inputSchema: { vault: vaultArg },
    },
    async (a) => json(await onVault(a.vault, rewardUnlock)),
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
