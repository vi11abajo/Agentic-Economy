// Turns "the wallet touched these tokens and contracts" into "the wallet has these positions right now".
// Everything is read at the scan's pinned block, in a few Multicall3 batches, and every figure becomes a fact.
import { formatUnits } from "viem";
import { batch } from "./reads.js";
import { nativeBalance, receiptTransfers, tokenMeta, WPROS, MULTICALL3, type TokenMeta } from "./chain.js";
import type { WalletIndex } from "./explorer.js";
import type { Ledger, Unknown } from "./facts.js";
import { groupFlows } from "./flows.js";
import type { ToolLine } from "./mcp.js";

export const MORPHO = "0x18573fa18fd17ddfd790b4a5b5b2977aad3b4efb";
export const NATIVE = "native";

export interface ScanCtx {
  line: ToolLine;
  block: number;
  ledger: Ledger;
  wallet: string;
}

export interface Underlying {
  token: string;
  amount: bigint;
  fact: string;
}

export interface Holding {
  /** token: sits in the wallet; vault: a share that converts into something else; lp: a pool share;
   *  lending / debt: Morpho; in-flight: a request a vault hasn't paid out yet. */
  kind: "token" | "vault" | "lp" | "lending" | "debt" | "in-flight";
  protocol: string;
  /** The token (or for Morpho, the market id) this line is about. */
  asset: string;
  symbol: string;
  amount: bigint;
  decimals: number;
  underlying?: Underlying[];
  /** Fact ids behind the amount and the underlying. */
  facts: string[];
  note?: string;
  /** The contract that holds the money when it isn't the share token itself (ERC-7540 vaults, Morpho). */
  venue?: string;
}

export interface Findings {
  holdings: Holding[];
  unknowns: Unknown[];
  checked: { tokens: number; nonZero: number };
  meta: Map<string, TokenMeta>;
}

const show = (amount: bigint, decimals: number) => formatUnits(amount, decimals);
const short = (a: string) => `${a.slice(0, 6)}...${a.slice(-4)}`;

const REQUEST_REDEEM = new Set(["0x7d41c86e"]); // requestRedeem(uint256,address,address)
const REQUEST_DEPOSIT = new Set(["0x85b77f45", "0x5696bdae"]); // standard, and the two-arg variant we met

export async function findHoldings(ctx: ScanCtx, ix: WalletIndex): Promise<Findings> {
  const w = ctx.wallet.toLowerCase();
  const holdings: Holding[] = [];
  const unknowns: Unknown[] = [];
  const flows = groupFlows(ix);

  // Native PROS first: it is the one balance that never shows up in token transfers.
  const pros = await nativeBalance(ctx.line, w, ctx.block);
  const prosFact = ctx.ledger.add({ label: "PROS in the wallet", value: show(pros, 18), raw: pros.toString(), unit: "PROS", call: `get_balance(${short(w)})`, block: ctx.block, source: "chain" });
  if (pros > 0n) holdings.push({ kind: "token", protocol: "wallet", asset: NATIVE, symbol: "PROS", amount: pros, decimals: 18, facts: [prosFact.id] });

  // Every token the wallet ever touched, and every contract it ever called.
  const tokens = [...new Set(ix.transfers.map((t) => t.token_address.toLowerCase()))];
  const fallback = new Map(ix.transfers.map((t) => [t.token_address.toLowerCase(), { symbol: t.token_info?.symbol, decimals: t.token_info?.decimals }]));
  const meta = await tokenMeta(ctx.line, tokens, ctx.block, fallback);
  const called = [...new Set(flows.filter((f) => f.sender === w && f.target && f.target !== w).map((f) => f.target!))];

  const balances = await batch(ctx, tokens.map((t) => ({ to: t, fn: "balanceOf", args: [w] })));
  const vaultProbe = await batch(ctx, called.flatMap((c) => [{ to: c, fn: "share" as const }, { to: c, fn: "asset" as const }, { to: c, fn: "name" as const }]));
  const vaultOfShare = new Map<string, { vault: string; asset: string; name: string }>();
  const vaults = new Set<string>();
  called.forEach((c, i) => {
    const share = vaultProbe[3 * i] as string | undefined;
    const asset = vaultProbe[3 * i + 1] as string | undefined;
    const name = (vaultProbe[3 * i + 2] as string | undefined) ?? short(c);
    if (asset) vaults.add(c);
    if (share && asset) vaultOfShare.set(share.toLowerCase(), { vault: c, asset: asset.toLowerCase(), name });
  });

  const held: { token: string; amount: bigint; m: TokenMeta; fact: string }[] = [];
  tokens.forEach((t, i) => {
    const m = meta.get(t)!;
    const bal = balances[i] as bigint | undefined;
    if (bal === undefined) {
      unknowns.push(ctx.ledger.unknown({ reason: "read-failed", subject: `${m.symbol} (${t})`, details: `balanceOf(${short(w)}) failed at block ${ctx.block}` }));
      return;
    }
    if (bal === 0n) return;
    const fact = ctx.ledger.add({ label: `${m.symbol} in the wallet`, value: show(bal, m.decimals), raw: bal.toString(), unit: m.symbol, contract: t, call: `balanceOf(${short(w)})`, block: ctx.block, source: "chain" });
    held.push({ token: t, amount: bal, m, fact: fact.id });
  });

  // What is each held token, really? One more batch: vault and pool getters on every non-zero token.
  const shape = await batch(ctx, held.flatMap((h) => [
    { to: h.token, fn: "asset" as const },
    { to: h.token, fn: "convertToAssets" as const, args: [h.amount] },
    { to: h.token, fn: "token0" as const },
    { to: h.token, fn: "token1" as const },
    { to: h.token, fn: "getReserves" as const },
    { to: h.token, fn: "totalSupply" as const },
  ]));
  const shareConversions = await batch(ctx, held.filter((h) => vaultOfShare.has(h.token)).map((h) => ({ to: vaultOfShare.get(h.token)!.vault, fn: "convertToAssets" as const, args: [h.amount] })));
  let conv = 0;

  for (const [i, h] of held.entries()) {
    const [asset, assets, t0, t1, reserves, supply] = shape.slice(6 * i, 6 * i + 6) as [string?, bigint?, string?, string?, (readonly bigint[])?, bigint?];
    const separate = vaultOfShare.get(h.token);
    if (separate) {
      const out = shareConversions[conv++] as bigint | undefined;
      if (out === undefined) {
        unknowns.push(ctx.ledger.unknown({ reason: "read-failed", subject: `${h.m.symbol} share of ${separate.name}`, details: `convertToAssets on vault ${separate.vault} failed at block ${ctx.block}` }));
        holdings.push({ kind: "vault", protocol: separate.name, asset: h.token, symbol: h.m.symbol, amount: h.amount, decimals: h.m.decimals, facts: [h.fact] });
        continue;
      }
      const um = meta.get(separate.asset) ?? { symbol: short(separate.asset), decimals: 18, from: "explorer" as const };
      const f = ctx.ledger.add({ label: `${h.m.symbol} shares are worth`, value: show(out, um.decimals), raw: out.toString(), unit: um.symbol, contract: separate.vault, call: "convertToAssets(shares)", block: ctx.block, source: "chain" });
      holdings.push({ kind: "vault", protocol: separate.name, asset: h.token, symbol: h.m.symbol, amount: h.amount, decimals: h.m.decimals, underlying: [{ token: separate.asset, amount: out, fact: f.id }], facts: [h.fact, f.id], venue: separate.vault });
    } else if (asset && assets !== undefined) {
      const a = asset.toLowerCase();
      const um = meta.get(a) ?? (await tokenMeta(ctx.line, [a], ctx.block, new Map())).get(a)!;
      if (!meta.has(a)) meta.set(a, um);
      const f = ctx.ledger.add({ label: `${h.m.symbol} shares are worth`, value: show(assets, um.decimals), raw: assets.toString(), unit: um.symbol, contract: h.token, call: "convertToAssets(balance)", block: ctx.block, source: "chain" });
      const name = (await batch(ctx, [{ to: h.token, fn: "name" }]))[0] as string | undefined;
      holdings.push({ kind: "vault", protocol: name ?? h.m.symbol, asset: h.token, symbol: h.m.symbol, amount: h.amount, decimals: h.m.decimals, underlying: [{ token: a, amount: assets, fact: f.id }], facts: [h.fact, f.id] });
    } else if (t0 && t1 && reserves && supply) {
      const [r0, r1] = reserves;
      const a0 = (r0 * h.amount) / supply;
      const a1 = (r1 * h.amount) / supply;
      const pair = [t0.toLowerCase(), t1.toLowerCase()];
      const missing = pair.filter((t) => !meta.has(t));
      if (missing.length) for (const [k, v] of await tokenMeta(ctx.line, missing, ctx.block, new Map())) meta.set(k, v);
      const [m0, m1] = pair.map((t) => meta.get(t)!);
      const f0 = ctx.ledger.add({ label: `your share of the pool's ${m0.symbol}`, value: show(a0, m0.decimals), raw: a0.toString(), unit: m0.symbol, contract: h.token, call: "getReserves() x balance / totalSupply()", block: ctx.block, source: "chain" });
      const f1 = ctx.ledger.add({ label: `your share of the pool's ${m1.symbol}`, value: show(a1, m1.decimals), raw: a1.toString(), unit: m1.symbol, contract: h.token, call: "getReserves() x balance / totalSupply()", block: ctx.block, source: "chain" });
      holdings.push({ kind: "lp", protocol: `${m0.symbol}/${m1.symbol} pool`, asset: h.token, symbol: h.m.symbol, amount: h.amount, decimals: h.m.decimals, underlying: [{ token: pair[0], amount: a0, fact: f0.id }, { token: pair[1], amount: a1, fact: f1.id }], facts: [h.fact, f0.id, f1.id] });
    } else {
      holdings.push({ kind: "token", protocol: "wallet", asset: h.token, symbol: h.m.symbol, amount: h.amount, decimals: h.m.decimals, facts: [h.fact] });
    }
  }

  holdings.push(...(await inFlight(ctx, flows, vaults, meta, unknowns)));
  if (called.includes(MORPHO)) holdings.push(...(await morphoPositions(ctx, flows, meta, unknowns)));
  unknowns.push(...(await unreadableDestinations(ctx, flows, vaults, new Set(tokens))));

  return { holdings, unknowns, checked: { tokens: tokens.length, nonZero: held.length }, meta };
}

/** ERC-7540 requests: money the wallet asked a vault for (or gave it) that hasn't come through yet. */
async function inFlight(ctx: ScanCtx, flows: ReturnType<typeof groupFlows>, vaults: Set<string>, meta: Map<string, TokenMeta>, unknowns: Unknown[]): Promise<Holding[]> {
  const w = ctx.wallet.toLowerCase();
  const asks = flows.filter((f) => f.sender === w && f.target && vaults.has(f.target) && f.method && (REQUEST_REDEEM.has(f.method) || REQUEST_DEPOSIT.has(f.method)));
  const out: Holding[] = [];
  const seen = new Set<string>();
  for (const f of asks) {
    const vault = f.target!;
    const redeem = REQUEST_REDEEM.has(f.method!);
    const receipt = await receiptTransfers(ctx.line, f.hash);
    // The vault's own Request event carries the id as its third indexed topic. No such event: id 0 (the default).
    const ids = (receipt.requestIds ?? []).filter((r) => r.vault === vault).map((r) => r.id);
    for (const id of ids.length ? ids : [0n]) {
      const key = `${vault}:${redeem}:${id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const [pending, claimable, asset, share, name] = await batch(ctx, [
        { to: vault, fn: redeem ? "pendingRedeemRequest" : "pendingDepositRequest", args: [id, w] },
        { to: vault, fn: redeem ? "claimableRedeemRequest" : "claimableDepositRequest", args: [id, w] },
        { to: vault, fn: "asset" },
        { to: vault, fn: "share" },
        { to: vault, fn: "name" },
      ]) as [bigint?, bigint?, string?, string?, string?];
      const label = name ?? short(vault);
      if (pending === undefined || claimable === undefined) {
        // Half an answer is no answer: "0 pending" means nothing if "claimable" won't say. Axil Pot does exactly this.
        const said = [pending !== undefined ? `pending reads ${pending}` : "pending reverts", claimable !== undefined ? `claimable reads ${claimable}` : "claimable reverts"].join(", ");
        const paidBack = flows.some((x) => x.block > f.block && x.in.some((m) => m.counterparty === vault));
        const sent = f.out.map((m) => `${m.amount} ${meta.get(m.token)?.symbol ?? m.token}`).join(", ") || "nothing we could see";
        unknowns.push(ctx.ledger.unknown({
          reason: "read-failed",
          subject: `${redeem ? "redeem" : "deposit"} request ${id} at ${label}`,
          details: `${said} on ${vault} at block ${ctx.block}; the request (tx ${f.hash}, block ${f.block}) sent ${sent}; ${paidBack ? "a payment from this vault has arrived since" : "no payment from this vault has arrived since"}`,
        }));
        continue;
      }
      // A redeem request is counted in shares; a deposit request in the asset the wallet handed over.
      const unitToken = (redeem ? share ?? vault : asset ?? "").toLowerCase();
      if (unitToken && !meta.has(unitToken)) for (const [k, v] of await tokenMeta(ctx.line, [unitToken], ctx.block, new Map())) meta.set(k, v);
      const um = meta.get(unitToken) ?? { symbol: "?", decimals: 18, from: "explorer" as const };
      for (const [stage, amount] of [["waiting", pending], ["ready to claim", claimable]] as const) {
        if (!amount) continue;
        const fn = `${stage === "waiting" ? "pending" : "claimable"}${redeem ? "Redeem" : "Deposit"}Request(${id})`;
        const fact = ctx.ledger.add({ label: `${redeem ? "redeem" : "deposit"} request ${stage} at ${label}`, value: show(amount, um.decimals), raw: amount.toString(), unit: um.symbol, contract: vault, call: fn, block: ctx.block, source: "chain" });
        const underlying: Underlying[] = [];
        if (redeem && asset) {
          const [assets] = (await batch(ctx, [{ to: vault, fn: "convertToAssets", args: [amount] }])) as [bigint?];
          if (assets !== undefined) {
            const am = meta.get(asset.toLowerCase()) ?? (await tokenMeta(ctx.line, [asset.toLowerCase()], ctx.block, new Map())).get(asset.toLowerCase())!;
            const uf = ctx.ledger.add({ label: `that request is worth`, value: show(assets, am.decimals), raw: assets.toString(), unit: am.symbol, contract: vault, call: "convertToAssets(shares)", block: ctx.block, source: "chain" });
            underlying.push({ token: asset.toLowerCase(), amount: assets, fact: uf.id });
          }
        }
        out.push({ kind: "in-flight", protocol: label, asset: unitToken, symbol: um.symbol, amount, decimals: um.decimals, underlying, facts: [fact.id, ...underlying.map((u) => u.fact)], note: `${redeem ? "redeem" : "deposit"} request ${id}, ${stage}, asked in tx ${f.hash}` });
      }
    }
  }
  return out;
}

/** Morpho Blue keeps positions inside the Morpho contract, no token. Markets come from the wallet's own receipts. */
async function morphoPositions(ctx: ScanCtx, flows: ReturnType<typeof groupFlows>, meta: Map<string, TokenMeta>, unknowns: Unknown[]): Promise<Holding[]> {
  const w = ctx.wallet.toLowerCase();
  const ids = new Set<string>();
  for (const f of flows.filter((x) => x.sender === w && x.target === MORPHO)) {
    const r = await receiptTransfers(ctx.line, f.hash);
    for (const id of r.morphoMarkets ?? []) ids.add(id);
  }
  const out: Holding[] = [];
  for (const id of ids) {
    const [pos, mkt, params] = (await batch(ctx, [
      { to: MORPHO, fn: "position", args: [id, w] },
      { to: MORPHO, fn: "market", args: [id] },
      { to: MORPHO, fn: "idToMarketParams", args: [id] },
    ])) as [(readonly bigint[])?, (readonly bigint[])?, (readonly [string, string, string, string, bigint])?];
    if (!pos || !mkt || !params) {
      unknowns.push(ctx.ledger.unknown({ reason: "read-failed", subject: `Morpho market ${id.slice(0, 10)}`, details: `position/market/idToMarketParams failed on ${MORPHO} at block ${ctx.block}` }));
      continue;
    }
    const [supplyShares, borrowShares, collateral] = pos;
    const [tsa, tss, tba, tbs] = mkt;
    const [loan, coll] = [params[0].toLowerCase(), params[1].toLowerCase()];
    const need = [loan, coll].filter((t) => !meta.has(t));
    if (need.length) for (const [k, v] of await tokenMeta(ctx.line, need, ctx.block, new Map())) meta.set(k, v);
    const lm = meta.get(loan)!, cm = meta.get(coll)!;
    const market = `Morpho ${cm.symbol}/${lm.symbol}`;
    const add = (kind: Holding["kind"], token: string, m: TokenMeta, amount: bigint, label: string, call: string) => {
      if (amount === 0n) return;
      const fact = ctx.ledger.add({ label, value: show(amount, m.decimals), raw: amount.toString(), unit: m.symbol, contract: MORPHO, call, block: ctx.block, source: "chain" });
      out.push({ kind, protocol: market, asset: token, symbol: m.symbol, amount, decimals: m.decimals, facts: [fact.id], note: `market ${id}` });
    };
    // Morpho's own rounding: what you supplied rounds down, what you owe rounds up.
    const supplied = tss > 0n ? (supplyShares * tsa) / tss : 0n;
    const owed = tbs > 0n ? (borrowShares * tba + tbs - 1n) / tbs : 0n;
    add("lending", loan, lm, supplied, `${lm.symbol} supplied to ${market}`, "position().supplyShares x market()");
    add("lending", coll, cm, collateral, `${cm.symbol} collateral in ${market}`, "position().collateral");
    add("debt", loan, lm, owed, `${lm.symbol} owed to ${market}`, "position().borrowShares x market(), rounded up");
  }
  return out;
}

const PLUMBING = new Set([WPROS, MULTICALL3.toLowerCase()]);

/**
 * Money that left the wallet into a contract we can't read, with nothing coming back in the same transaction.
 * These are the honest "I can't see what you have there" lines.
 */
async function unreadableDestinations(ctx: ScanCtx, flows: ReturnType<typeof groupFlows>, vaults: Set<string>, tokens: Set<string>): Promise<Unknown[]> {
  const w = ctx.wallet.toLowerCase();
  const byTarget = new Map<string, { methods: Set<string>; txs: number; sent: Map<string, number> }>();
  for (const f of flows) {
    if (f.sender !== w || !f.target || f.in.length || !f.out.length) continue;
    if (vaults.has(f.target) || f.target === MORPHO || PLUMBING.has(f.target)) continue;
    // A plain token send (transfer to a person) calls the token itself: that's a payment, not a protocol.
    if (tokens.has(f.target) || f.target === w) continue;
    const entry = byTarget.get(f.target) ?? { methods: new Set(), txs: 0, sent: new Map() };
    entry.methods.add(f.method ?? "?");
    entry.txs++;
    for (const m of f.out) entry.sent.set(m.token, (entry.sent.get(m.token) ?? 0) + Number(m.amount));
    byTarget.set(f.target, entry);
  }
  // Sending PROS to a person is a payment, not a protocol: only addresses with code count.
  const out: Unknown[] = [];
  for (const [target, e] of byTarget) {
    const { code } = JSON.parse(await ctx.line.ask("get_code", { address: target, block: String(ctx.block) })) as { code: string };
    if (!code || code === "0x") continue;
    out.push(ctx.ledger.unknown({
      reason: "no-adapter",
      subject: target,
      details: `the wallet sent ${[...e.sent.entries()].map(([t, a]) => `${a} ${t === "native" ? "PROS" : short(t)}`).join(", ")} there in ${e.txs} tx (method ${[...e.methods].join(", ")}) and got nothing back in those txs; receipts has no reader for this contract`,
    }));
  }
  return out;
}
