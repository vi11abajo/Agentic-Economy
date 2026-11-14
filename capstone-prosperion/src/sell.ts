// Selling a pToken back into its curve. The person says it however they like ("half", "all of it", "25%", "1,000
// tokens"); the agent turns that into one of three plain forms and the server does the arithmetic on the wallet's
// own balance at one block, so a model never multiplies an 18-decimal number. The quote goes back to the person to
// confirm, and only then is a request saved. The sign page re-reads everything when the wallet is about to open.
//
// Two transactions, the same ones Prosper's own app sends: approve the trade router for exactly this many tokens
// (skipped when it may already take them), then sellInner with nativeOut = true, which pays plain PROS to the
// seller. Checked on mainnet: tx 0x7ad87c8f… at block 22,978,024 raised the seller's PROS by 107.98 against a
// minOut of 106.9. One transaction would need a contract of ours in the middle (the pTokens do support EIP-2612
// permit); the gate cannot do it, its code is fixed.
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, parseAbi, parseUnits, type Address, type Hex, type PublicClient } from "viem";
import { MIN_OUT_BPS, type RequestSource } from "./prepare.js";
import { requestUrl } from "./links.js";
import type { MarketCheck } from "./market.js";
import type { Store } from "./store.js";

/** Prosper's trade router, as https://api.pros-per.xyz/api/v1/deployment lists it (tradeRouter). */
export const TRADE_ROUTER: Address = "0x63FfADf944583D8e4Fdc30144EFdfe3bdC2122f5";
export const ROUTER_ABI = parseAbi([
  "function sellInner(address market, uint256 pTokenIn, uint256 minOut, uint256 deadline, bool nativeOut) returns (uint256 amountOut)",
]);
const QUOTE_ABI = parseAbi([
  "function quoteSell(uint256 pTokenIn) view returns (uint256 grossWrappedNativeOut, uint256 fee, uint256 netWrappedNativeOut)",
]);

/** Everything a sell depends on, read at one block. */
export interface SellState {
  market: Address;
  block: bigint;
  genuine: boolean;
  phase: number;
  pToken: Address | null;
  symbol: string;
  decimals: number;
  balance: bigint;
  /** what the trade router may already take from this wallet */
  allowance: bigint;
  amount: bigint;
  /** the curve's quote for `amount`; null when there is nothing to quote */
  quote: { gross: bigint; fee: bigint; net: bigint } | null;
}
/** Reads the state for a sell of `pick(balance)` tokens; pick sees the balance at the same block it quotes at. */
export type SellReader = (market: Address, owner: Address, pick: (balance: bigint, decimals: number) => bigint) => Promise<SellState>;

export function chainSellReader(client: PublicClient, check: (market: Address, amountIn: bigint) => Promise<MarketCheck>): SellReader {
  return async (market, owner, pick) => {
    const m = await check(market, 0n);
    const base = { market: m.market, block: m.block, genuine: m.genuine, phase: m.phase, pToken: m.pToken };
    if (!m.genuine || !m.pToken) return { ...base, symbol: "", decimals: 18, balance: 0n, allowance: 0n, amount: 0n, quote: null };
    const at = { blockNumber: m.block };
    const [symbol, decimals, balance, allowance] = await Promise.all([
      client.readContract({ address: m.pToken, abi: erc20Abi, functionName: "symbol", ...at }),
      client.readContract({ address: m.pToken, abi: erc20Abi, functionName: "decimals", ...at }),
      client.readContract({ address: m.pToken, abi: erc20Abi, functionName: "balanceOf", args: [owner], ...at }),
      client.readContract({ address: m.pToken, abi: erc20Abi, functionName: "allowance", args: [owner, TRADE_ROUTER], ...at }),
    ]);
    const amount = pick(balance, decimals);
    let quote: SellState["quote"] = null;
    if (m.phase === 0 && amount > 0n && amount <= balance) {
      const [gross, fee, net] = await client.readContract({ address: market, abi: QUOTE_ABI, functionName: "quoteSell", args: [amount], ...at });
      quote = { gross, fee, net };
    }
    return { ...base, symbol, decimals, balance, allowance, amount, quote };
  };
}

/**
 * "all", "100%", "50%", "12.5%" or a number of tokens ("1000", "208818.1595"), against this balance.
 * The words people use ("half", "a quarter", "everything") are the agent's job to turn into one of these.
 */
export function parseSellAmount(spec: string, balance: bigint, decimals = 18): { amount: bigint; percent: number | null } | { error: string } {
  const s = spec.trim().toLowerCase().replace(/,/g, "");
  if (s === "all" || s === "max" || s === "100%") return { amount: balance, percent: 100 };
  const pct = /^(\d+(?:\.\d{1,2})?)\s*%$/.exec(s);
  if (pct) {
    const p = Number(pct[1]);
    if (!(p > 0 && p <= 100)) return { error: "A share must be more than 0% and at most 100%." };
    return { amount: (balance * BigInt(Math.round(p * 100))) / 10_000n, percent: p };
  }
  if (new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`).test(s)) return { amount: parseUnits(s, decimals), percent: null };
  return { error: `Could not read "${spec}" as an amount. Use all, a share like 50%, or a number of tokens like 1000.` };
}

const plain = (w: bigint, d: number) => formatUnits(w, d);
/** Why this sell cannot go ahead, in words; undefined if it can. */
export function sellRefusal(s: SellState): string | undefined {
  if (!s.genuine || !s.pToken) return "Not a Prosper market: the factory does not list it.";
  if (s.phase === 2) return `${s.symbol} graduated: it trades on FaroSwap now, not on the curve. Prosperion prepares curve sells only.`;
  if (s.phase !== 0) return `${s.symbol} is not on the curve any more (phase ${s.phase}). Prosperion prepares curve sells only.`;
  if (s.balance === 0n) return `This wallet holds no ${s.symbol} at block ${s.block}.`;
  if (s.amount <= 0n) return "The amount to sell comes out as zero.";
  if (s.amount > s.balance) return `That is more than the wallet holds: ${plain(s.balance, s.decimals)} ${s.symbol} at block ${s.block}.`;
  if (!s.quote || s.quote.net === 0n) return `The curve quotes nothing for ${plain(s.amount, s.decimals)} ${s.symbol}.`;
  return undefined;
}

export interface SellPreview {
  ok: true;
  block: bigint;
  market: Address;
  pToken: Address;
  symbol: string;
  /** what the wallet holds, in tokens, exact */
  balanceTokens: string;
  /** what would be sold, in tokens, exact: pass this to prepare_sell as is */
  amountTokens: string;
  /** the share of the balance it is, to two decimals */
  sharePct: number;
  grossPros: string;
  feePros: string;
  /** PROS that reach the wallet at this block's price */
  netPros: string;
  /** the floor the sell transaction asks for; it reverts below this */
  minNetPros: string;
  approveNeeded: boolean;
}

export async function sellQuote(read: SellReader, market: Address, owner: Address, spec: string): Promise<SellPreview | { ok: false; refusal: string; block?: bigint }> {
  let parseError: string | null = null;
  const s = await read(market, owner, (balance, decimals) => {
    const p = parseSellAmount(spec, balance, decimals);
    if ("error" in p) { parseError = p.error; return 0n; }
    return p.amount;
  });
  if (parseError) return { ok: false, refusal: parseError, block: s.block };
  const why = sellRefusal(s);
  if (why) return { ok: false, refusal: why, block: s.block };
  const q = s.quote!;
  return {
    ok: true, block: s.block, market: s.market, pToken: s.pToken!, symbol: s.symbol,
    balanceTokens: plain(s.balance, s.decimals), amountTokens: plain(s.amount, s.decimals),
    // rounded, not floored: half of an odd balance in wei is still 50%
    sharePct: Math.round(Number((s.amount * 1_000_000n) / s.balance) / 100) / 100,
    grossPros: plain(q.gross, 18), feePros: plain(q.fee, 18), netPros: plain(q.net, 18),
    minNetPros: plain((q.net * BigInt(MIN_OUT_BPS)) / 10_000n, 18),
    approveNeeded: s.allowance < s.amount,
  };
}

export interface PrepareSellInput { market: Address; owner: Address; amountTokens: string; source: RequestSource }
export type PreparedSell = { ok: true; id: string; url: string; preview: SellPreview } | { ok: false; refusal: string; block?: bigint };

/** Saves a sell the person confirmed, for exactly the token amount the quote showed them. */
export async function prepareSell(store: Store, read: SellReader, i: PrepareSellInput): Promise<PreparedSell> {
  if (!/^\d+(\.\d+)?$/.test(i.amountTokens.trim())) return { ok: false, refusal: "amountTokens must be the exact number of tokens from sell_quote, like 104409.07975." };
  const q = await sellQuote(read, i.market, i.owner, i.amountTokens.trim());
  if (!q.ok) return q;
  const id = store.saveRequest({
    kind: "sell", createdBlock: q.block,
    params: {
      market: getAddress(i.market), owner: getAddress(i.owner), pToken: q.pToken, symbol: q.symbol,
      amountTokens: q.amountTokens, minOutBps: MIN_OUT_BPS, source: i.source,
    },
  });
  return { ok: true, id, url: requestUrl(id), preview: q };
}

export interface SellTxs {
  /** null when the router may already take these tokens */
  approve: { to: Address; value: "0"; data: Hex } | null;
  sell: { to: Address; value: "0"; data: Hex; minOut: string; deadline: string };
}
/** The two transactions for a fresh state, or the reason there are none. */
export function sellTxs(s: SellState, nowSec: number): SellTxs | { refusal: string } {
  const why = sellRefusal(s);
  if (why) return { refusal: why };
  const minOut = (s.quote!.net * BigInt(MIN_OUT_BPS)) / 10_000n;
  const deadline = BigInt(nowSec + 600);
  return {
    approve: s.allowance >= s.amount ? null : {
      to: s.pToken!, value: "0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [TRADE_ROUTER, s.amount] }),
    },
    sell: {
      to: TRADE_ROUTER, value: "0",
      data: encodeFunctionData({ abi: ROUTER_ABI, functionName: "sellInner", args: [s.market, s.amount, minOut, deadline, true] }),
      minOut: minOut.toString(), deadline: deadline.toString(),
    },
  };
}
