// Prosperion's own MCP server: the agent's only way to get Prosper numbers. Every answer carries the block it was
// read at, so the agent can quote the block and cross-check it through the Pharos Chain MCP at that same block.
// One tool writes: prepare_buy saves a request and hands back a link to our sign page. No tool here builds, signs or
// sends a transaction; the sign page builds it when the visitor's own wallet is about to open.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatEther, getAddress, isAddress, parseEther, toFunctionSelector, type Address } from "viem";
import { z } from "zod";
import { checkMarket } from "./market.js";
import { MAX_SPAN, explainNavMove } from "./navmove.js";
import { readPosition } from "./position.js";
import { loadProtocol } from "./protocol.js";
import { listVaults } from "./prosperApi.js";
import { rewardUnlock } from "./rewards.js";
import { readVault } from "./vault.js";
import { findVault } from "./vaultLookup.js";
import type { PrepareInput, Prepared } from "./prepare.js";
import { rankBoard, readBoard, readVaultProfile } from "./board.js";
import { readPortfolio } from "./portfolio.js";
import { vaultDetail } from "./prosperApi.js";
import type { TradeBook } from "./trades.js";

export interface LaunchRow {
  market: Address;
  vault: Address;
  pToken: Address;
  block: bigint;
  tx: string;
}
export interface McpDeps {
  listLaunches: (limit: number) => LaunchRow[];
  prepareBuy: (input: PrepareInput) => Promise<Prepared>;
  /** Prosperion's index of every curve buy and sell; null in tests that do not need it */
  trades?: TradeBook | null;
  /** the head block, to say how far behind the trade index is */
  head?: () => Promise<bigint>;
}

const pros = (wei: bigint) => formatEther(wei);

const prosAmount = z.string().regex(/^\d+(\.\d{1,18})?$/);

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
      description: "Only the markets Prosperion's watcher saw being created since it started, newest first. For the whole of Prosper (every market, open or closed) use launch_board. Run market_check on one before saying anything about it.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async (a) => json(deps.listLaunches(a.limit ?? 10)),
  );

  server.registerTool(
    "launch_board",
    {
      title: "Every Prosper market, ranked",
      description: "All Prosper markets read on chain at one block: phase, PROS in the curve against the graduation target, progress, and hours until the window closes (negative = closed). status: curve (default: still open, closest to graduating first), graduated, failed or all. buyers/holders come from Prosperion's trade index when it has the market. Use this for 'which launches are open', 'which is closest to graduating', 'what is ending soon'.",
      inputSchema: { status: z.enum(["curve", "graduated", "failed", "all"]).optional(), limit: z.number().int().min(1).max(80).optional() },
    },
    async (a) => {
      const b = await readBoard(await vaultRows(), deps.trades ?? undefined);
      const all = b.entries;
      const rows = rankBoard(all, a.status ?? "curve", a.limit ?? 20).map((e) => ({
        symbol: e.symbol, token: e.token, vault: e.vaultName, market: e.market, phase: e.phaseName,
        prosInCurve: pros(e.prosInCurve), targetPros: pros(e.target), progressPercent: e.progressBps / 100,
        windowEnds: new Date(e.endsAt * 1000).toISOString(), hoursLeft: e.hoursLeft,
        ...(e.buyers !== undefined ? { buyers: e.buyers, holdersFromCurve: e.holders } : {}),
      }));
      const count = (ph: number) => all.filter((e) => e.phase === ph).length;
      return json({ block: b.block, time: b.time, totals: { markets: all.length, onCurve: count(0), graduated: count(2), failed: count(3) }, markets: rows });
    },
  );

  server.registerTool(
    "market_trades",
    {
      title: "Who bought and sold in one market",
      description: "Every buy and sell on one market's curve, from the market's own events indexed by Prosperion: how many buys, sells, distinct buyers, PROS paid in (gross, fee included), PROS paid out, fees, wallets still holding from curve trades with what they paid, wallets that bought and sold everything back (roundTrips), and the latest trades with tx hashes. Curve trades only: tokens moved wallet to wallet, or traded on FaroSwap after graduation, are not counted. coverage = the block range indexed; reserveCheck = the curve's PROS read on chain now. Use for 'how many people bought', 'who holds', 'last trades'.",
      inputSchema: { market: addr.describe("the market address (list_vaults or launch_board give it)"), limit: z.number().int().min(1).max(50).optional() },
    },
    async (a) => {
      if (!deps.trades) throw new Error("The trade index is not running on this copy.");
      const market = getAddress(a.market);
      const cov = deps.trades.coverage();
      const head = deps.head ? await deps.head() : null;
      const s = deps.trades.summary(market);
      const m = await checkMarket(market, 0n);
      return json({
        market, genuine: m.genuine, phase: m.phase,
        coverage: cov ? { fromBlock: cov.from, toBlock: cov.to, blocksBehindHead: head !== null ? head - cov.to : null } : "not started",
        buys: s.buys, sells: s.sells, buyers: s.buyers, sellers: s.sellers,
        prosPaidIn: pros(s.prosInGross), prosPaidOut: pros(s.prosOutNet), feesPros: pros(s.feesPaid),
        firstTradeBlock: s.firstTrade, lastTradeBlock: s.lastTrade,
        holdersFromCurve: s.holdersFromCurve.slice(0, 25).map((h) => ({ wallet: h.wallet, tokens: pros(h.tokens), prosPaid: pros(h.prosPaid) })),
        holdersCount: s.holdersFromCurve.length, roundTrips: s.roundTrips,
        latest: deps.trades.trades(market, a.limit ?? 10).map((t) => ({
          block: t.block, tx: t.tx, kind: t.kind, wallet: t.trader, tokens: pros(t.tokens),
          pros: pros(t.kind === "buy" ? t.prosGross : t.prosNet), feePros: pros(t.fee),
        })),
        reserveCheck: { block: m.block, prosInCurve: pros(m.reserveBefore), call: { to: market, data: toFunctionSelector("realWrappedNativeReserve()"), block: m.block, expect: m.reserveBefore } },
      });
    },
  );

  server.registerTool(
    "wallet_portfolio",
    {
      title: "Everything a wallet holds in Prosper",
      description: "One read at one block over every Prosper market and vault: which pTokens and vault shares the wallet holds, what a full curve sell of each pToken pays now (null after graduation), and what the vault shares are worth in USDC (6 decimals) at the vault's own share price. Use this instead of calling position market by market.",
      inputSchema: { owner: addr },
    },
    async (a) => json(await readPortfolio(getAddress(a.owner), await vaultRows())),
  );

  server.registerTool(
    "vault_profile",
    {
      title: "Who runs a vault and what it charges",
      description: "Curator address, management/performance/deposit/withdrawal fees, settlement and withdrawal days, minimum deposit, strategy text, declared positions, AUM, APY and holders, as Prosper's API publishes them (labelled fromProsperApi, not on chain), next to the share price read on chain (onChain.navPerShareUsdc) to check the API's NAV against.",
      inputSchema: { vault: vaultArg },
    },
    async (a) => json(await onVault(a.vault, (v) => readVaultProfile(v, vaultDetail))),
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

  server.registerTool(
    "prepare_buy",
    {
      title: "Prepare a first buy for the visitor to sign",
      description: "Only when the visitor asks to buy into a market and names the PROS amount. owner = the visitor's connected address from the page note, never one typed in the chat. Checks the market again and saves a request; returns a link to the Prosperion sign page, where the visitor's own wallet signs (a one-time limits step, then the buy through the ProsperionGate). The gate reverts if more PROS than maxProsInCurve (default: what is in now) is in the curve when the buy lands. ok=false with a refusal when the market is not genuine, off the curve or already taken.",
      inputSchema: {
        market: addr,
        owner: addr,
        amountPros: prosAmount.describe("PROS to spend, e.g. \"0.5\""),
        maxProsInCurve: prosAmount.optional().describe("Go ahead only while at most this much PROS is in the curve"),
      },
    },
    async (a) => {
      const r = await deps.prepareBuy({
        market: getAddress(a.market), owner: getAddress(a.owner), amountWei: parseEther(a.amountPros),
        maxReserveBeforeWei: a.maxProsInCurve === undefined ? undefined : parseEther(a.maxProsInCurve), source: "agent",
      });
      return json(r.ok
        ? { ok: true, url: r.url, block: r.check?.block, prosInCurve: r.check?.reserveBefore, note: "Give the visitor this link. Their own wallet signs on that page; nothing has been sent." }
        : { ok: false, refusal: r.refusal, block: r.check?.block });
    },
  );

  return server;
}
