// One adapter per kind of vault: what it pays, whether it takes this deposit right now, how money gets out, the
// user's position, and the unsigned transactions for deposit / withdraw / claim. Every read is at the run's
// pinned block. A venue's failure is its own: the router catches it and marks only that venue as down.
import {
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  keccak256,
  parseAbi,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { mergeOverrides, simulate, tokenOverride, USDC, type Step } from "./chain.js";
import { MORPHO, type Venue } from "./venues.js";

export const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export const VAULT = parseAbi([
  "function asset() view returns (address)",
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function convertToShares(uint256) view returns (uint256)",
  "function maxRedeem(address) view returns (uint256)",
  "function maxDeposit(address) view returns (uint256)",
  "function epochManager() view returns (address)",
  "function isLocked() view returns (bool)",
  "function currentEpoch() view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function deposit(uint256 assets, address receiver, address controller) returns (uint256)",
  "function requestDeposit(uint256 assets, address controller, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function requestRedeem(uint256 shares, address controller, address owner) payable returns (uint256)",
  "function pendingDepositRequest(uint256, address) view returns (uint256)",
  "function claimableDepositRequest(uint256, address) view returns (uint256)",
  "function pendingRedeemRequest(uint256, address) view returns (uint256)",
  "function claimableRedeemRequest(uint256, address) view returns (uint256)",
  "function redeemShares(uint256 shares, address receiver) returns (uint256)",
  // R25
  "function minDepositLimit() view returns (uint256)",
  "function minDepositAssets() view returns (uint256)",
  "function maturityPeriod() view returns (uint256)",
  "function redeemFeeBps() view returns (uint256)",
  "function withdrawFeeBps() view returns (uint256)",
  "function nativeFee() view returns (uint256)",
  "function getUserDailyWithdrawQuota(address) view returns (uint256)",
  // Morpho Vault V2
  "function liquidityAdapter() view returns (address)",
  "function liquidityData() view returns (bytes)",
  // BitFi
  "function underlyingAsset() view returns (address)",
]);

export const MORPHO_ABI = parseAbi([
  "function market(bytes32) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)",
]);

export interface Ctx {
  client: PublicClient;
  block: bigint;
  time: bigint;
  /** Blocks about 7 and 30 days back, for the realized yield. */
  past: Map<number, { block: bigint; time: bigint }>;
}

export interface Quote {
  venue: Venue;
  status: "open" | "closed" | "down";
  /** Why it's closed (the decoded revert of the simulated deposit) or why it's down. */
  reason?: string;
  decimals: number;
  tvl?: number;
  /** Realized yield from the share price, % a year, over the last 7 and 30 days. */
  apy: { d7?: number; d30?: number };
  minDeposit?: number;
  /** Days until money is out: 0 = at once. */
  exitDays?: number;
  exitHow: string;
  exitFeePct: number;
  /** PROS that has to be sent with the exit request. */
  exitNativeFee?: bigint;
  /** What can leave right now (vaults that pay out at once). */
  exitLiquidity?: number;
  asyncDeposit: boolean;
  notes: string[];
}

export interface Position {
  venue: Venue;
  shares: bigint;
  shareDecimals: number;
  assets: number;
  pendingDeposit?: number;
  claimableDeposit?: number;
  pendingRedeem?: number;
  claimableRedeem?: number;
}

const DEC = 6; // every open Harbor venue takes USDC
const human = (x: bigint, d = DEC) => Number(formatUnits(x, d));

async function read<T>(ctx: Ctx, address: Address, functionName: string, args: unknown[] = [], block = ctx.block): Promise<T> {
  return (await ctx.client.readContract({ address, abi: [...VAULT, ...ERC20], functionName, args, blockNumber: block } as never)) as T;
}

/** A read that may not exist on this vault: undefined on revert. */
async function maybe<T>(ctx: Ctx, address: Address, fn: string, args: unknown[] = [], block = ctx.block): Promise<T | undefined> {
  try {
    return await read<T>(ctx, address, fn, args, block);
  } catch (e) {
    if (/HTTP request failed|timed? ?out|fetch failed|429|too fast|cu limit/i.test(String((e as Error)?.message))) throw e;
    return undefined;
  }
}

/** Annualized growth of the share price between two blocks, in %. */
export function annualize(pNow: bigint, pThen: bigint, seconds: number): number | undefined {
  if (pThen <= 0n || seconds <= 0) return undefined;
  const ratio = Number(pNow) / Number(pThen);
  return (Math.pow(ratio, (365 * 86400) / seconds) - 1) * 100;
}


/** The unsigned transactions that put `amount` (base units) of USDC into the venue. */
export function depositSteps(v: Venue, user: Address, amount: bigint): Step[] {
  const approve: Step = {
    label: `approve ${formatUnits(amount, DEC)} USDC to ${v.name}`,
    to: v.asset ?? USDC,
    data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [v.address, amount] }),
    value: 0n,
  };
  const isRequest = v.kind === "full-async" || v.kind === "centrifuge";
  const call: Step = isRequest
    ? {
        label: `request a deposit of ${formatUnits(amount, DEC)} USDC into ${v.name}`,
        to: v.address,
        data: encodeFunctionData({ abi: VAULT, functionName: "requestDeposit", args: [amount, user, user] }),
        value: 0n,
      }
    : {
        label: `deposit ${formatUnits(amount, DEC)} USDC into ${v.name}`,
        to: v.address,
        data: encodeFunctionData({ abi: VAULT, functionName: "deposit", args: [amount, user] }),
        value: 0n,
      };
  return [approve, call];
}

/** The unsigned transactions that take `shares` out (at once, or as a request the vault fulfils later). */
export function withdrawSteps(v: Venue, user: Address, shares: bigint, nativeFee = 0n): Step[] {
  if (v.kind === "vault-v2" || v.kind === "r25-sync") {
    return [{ label: `redeem ${v.name} shares for USDC`, to: v.address, data: encodeFunctionData({ abi: VAULT, functionName: "redeem", args: [shares, user, user] }), value: 0n }];
  }
  if (v.kind === "ember") {
    return [
      { label: `approve ${v.name} shares to the vault`, to: v.share ?? v.address, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [v.address, shares] }), value: 0n },
      { label: `ask ${v.name} to redeem the shares`, to: v.address, data: encodeFunctionData({ abi: VAULT, functionName: "redeemShares", args: [shares, user] }), value: 0n },
    ];
  }
  return [
    {
      label: `request redemption of ${v.name} shares${nativeFee ? " (with the vault's PROS fee)" : ""}`,
      to: v.address,
      data: encodeFunctionData({ abi: VAULT, functionName: "requestRedeem", args: [shares, user, user] }),
      value: nativeFee,
    },
  ];
}

/** Claim what a request vault has made claimable. */
export function claimSteps(v: Venue, user: Address, p: { claimableDepositRaw?: bigint; claimableRedeemRaw?: bigint }): Step[] {
  const out: Step[] = [];
  if (p.claimableDepositRaw) {
    out.push({
      label: `claim the shares of the filled deposit request in ${v.name}`,
      to: v.address,
      data: encodeFunctionData({ abi: VAULT, functionName: "deposit", args: [p.claimableDepositRaw, user, user] }),
      value: 0n,
    });
  }
  if (p.claimableRedeemRaw) {
    out.push({
      label: `claim the USDC of the filled redemption in ${v.name}`,
      to: v.address,
      data: encodeFunctionData({ abi: VAULT, functionName: "redeem", args: [p.claimableRedeemRaw, user, user] }),
      value: 0n,
    });
  }
  return out;
}

/** Free liquidity of a Morpho Blue market given its params (loan, collateral, oracle, irm, lltv). */
export async function morphoFree(ctx: Ctx, params: readonly [Address, Address, Address, Address, bigint]): Promise<bigint> {
  const id = keccak256(encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], [...params]));
  const m = (await ctx.client.readContract({ address: MORPHO, abi: MORPHO_ABI, functionName: "market", args: [id], blockNumber: ctx.block })) as readonly bigint[];
  return m[0] - m[2];
}

/**
 * Everything the router needs about one venue, for a deposit of `amount` (base units) from `from`.
 * The deposit itself is simulated with `from` given the USDC and the allowance, so "open" means this exact
 * deposit would go through now: minimums, caps, pauses, whitelists and KYB all show up as its revert.
 */
export async function quote(ctx: Ctx, v: Venue, from: Address, amount: bigint): Promise<Quote> {
  const q: Quote = { venue: v, status: "closed", decimals: DEC, apy: {}, exitHow: "", exitFeePct: 0, asyncDeposit: false, notes: [] };

  if (v.kind === "token-only") {
    if (v.address !== zeroAddress) {
      const dec = await read<number>(ctx, v.address, "decimals");
      q.decimals = dec;
      q.tvl = human(await read<bigint>(ctx, v.address, "totalSupply"), dec);
      if (v.id === "bfbtc") {
        const u = await maybe<Address>(ctx, v.address, "underlyingAsset");
        if (u && u !== zeroAddress) q.notes.push(`underlyingAsset() is now ${u}: worth a new look`);
      }
    }
    q.reason = v.why;
    q.exitHow = "-";
    return q;
  }

  const shareToken = v.share ?? v.address;
  const shareDec = await read<number>(ctx, shareToken, "decimals");
  const one = 10n ** BigInt(shareDec);
  const pNow = await read<bigint>(ctx, v.address, "convertToAssets", [one]);
  for (const [d, at] of ctx.past) {
    const pThen = await maybe<bigint>(ctx, v.address, "convertToAssets", [one], at.block);
    if (pThen) q.apy[d === 7 ? "d7" : "d30"] = annualize(pNow, pThen, Number(ctx.time - at.time));
  }
  if (v.kind === "accountable") {
    // totalAssets() here is only the idle cash; what is lent out is in the share price.
    q.tvl = human(await read<bigint>(ctx, v.address, "convertToAssets", [await read<bigint>(ctx, v.address, "totalSupply")]));
  } else {
    q.tvl = human(await read<bigint>(ctx, v.address, "totalAssets"));
  }

  // The deposit, simulated.
  const [, call] = depositSteps(v, from, amount);
  const asset = v.asset ?? USDC;
  const sim = await simulate(ctx.client, from, call, mergeOverrides(tokenOverride(asset, from, { balance: amount, spender: v.address, allowance: amount })), ctx.block);
  q.status = sim.ok ? "open" : "closed";
  if (!sim.ok) q.reason = sim.reason;
  // Some reverts carry no reason or an unnamed error; the vault's own state says why.
  if (!sim.ok && v.kind === "epoch") {
    const em = await maybe<Address>(ctx, v.address, "epochManager");
    const locked = em ? await maybe<boolean>(ctx, em, "isLocked") : undefined;
    const epoch = em ? await maybe<bigint>(ctx, em, "currentEpoch") : undefined;
    if (locked) q.reason = `deposits are closed for the current epoch${epoch !== undefined ? ` (#${epoch})` : ""}: epochManager.isLocked() = true`;
  }
  if (!sim.ok && v.kind === "centrifuge" && (await maybe<bigint>(ctx, v.address, "maxDeposit", [from])) === 0n) {
    q.reason = "members only (KYB): maxDeposit is 0 for this address";
  }

  const min = (await maybe<bigint>(ctx, v.address, "minDepositLimit")) ?? (await maybe<bigint>(ctx, v.address, "minDepositAssets"));
  if (min !== undefined) q.minDeposit = human(min);

  switch (v.kind) {
    case "vault-v2": {
      q.exitDays = 0;
      q.exitHow = "withdraw at once, up to the vault's free liquidity";
      let free = await read<bigint>(ctx, USDC, "balanceOf", [v.address]);
      const adapter = await read<Address>(ctx, v.address, "liquidityAdapter");
      if (adapter !== zeroAddress) {
        const data = await read<Hex>(ctx, v.address, "liquidityData");
        if (data.length >= 2 + 64 * 5) {
          const w = (i: number) => `0x${data.slice(2 + 64 * i, 2 + 64 * (i + 1))}` as Hex;
          const addr = (i: number) => `0x${w(i).slice(26)}` as Address;
          free += await morphoFree(ctx, [addr(0), addr(1), addr(2), addr(3), BigInt(w(4))]);
        }
      }
      q.exitLiquidity = human(free);
      break;
    }
    case "r25-sync": {
      const mat = await maybe<bigint>(ctx, v.address, "maturityPeriod");
      q.exitDays = mat !== undefined ? Number(mat) / 86400 : undefined;
      q.exitHow = `redeem at once once shares are ${q.exitDays ?? "?"} day(s) old`;
      const quota = await maybe<bigint>(ctx, v.address, "getUserDailyWithdrawQuota", [from]);
      if (quota !== undefined) q.notes.push(`instant withdraw quota ${human(quota).toLocaleString("en-US")} USDC a day per wallet`);
      const fee = await maybe<bigint>(ctx, v.address, "withdrawFeeBps");
      if (fee) q.exitFeePct = Number(fee) / 100;
      break;
    }
    case "r25-async": {
      const mat = await maybe<bigint>(ctx, v.address, "maturityPeriod");
      q.exitDays = mat !== undefined ? Math.round(Number(mat) / 86400) : v.requestDays;
      q.exitHow = mat !== undefined ? `request redemption; shares mature after ${q.exitDays} days` : `request redemption; the operator pays out (Harbor: ${v.harbor.liquidity})`;
      const fee = (await maybe<bigint>(ctx, v.address, "redeemFeeBps")) ?? (await maybe<bigint>(ctx, v.address, "withdrawFeeBps"));
      if (fee) q.exitFeePct = Number(fee) / 100;
      const nf = await maybe<bigint>(ctx, v.address, "nativeFee");
      if (nf) {
        q.exitNativeFee = nf;
        q.notes.push(`a redemption request costs ${formatUnits(nf, 18)} PROS`);
      }
      break;
    }
    case "full-async":
      q.asyncDeposit = true;
      q.exitDays = v.requestDays;
      q.exitHow = `deposit and redemption are both requests (Harbor: ${v.harbor.liquidity})`;
      break;
    case "accountable":
    case "epoch":
    case "ember":
    case "centrifuge":
      q.asyncDeposit = v.kind === "centrifuge";
      q.exitDays = v.requestDays;
      q.exitHow = v.kind === "ember" ? "redeemShares request, the operator pays out" : `request redemption (Harbor: ${v.harbor.liquidity})`;
      break;
  }

  if (q.apy.d7 !== undefined && q.apy.d30 !== undefined && (q.apy.d7 < 0 || q.apy.d30 < 0)) q.notes.push("share price went down over one of the windows: it moves both ways");
  return q;
}

/** The user's shares, their value and open requests in one venue. */
/**
 * What `user` holds in a venue. Request vaults are read at request id 0 (ERC-7540 vaults that don't number
 * requests) and at every id in `requestIds` (vaults that do, such as Axil Pot; the ids come from the receipts
 * of requests this tool sent).
 */
export async function position(ctx: Ctx, v: Venue, user: Address, requestIds: bigint[] = []): Promise<Position & { claimableDepositRaw?: bigint; claimableRedeemRaw?: bigint }> {
  if (v.kind === "token-only") {
    if (v.address === zeroAddress) return { venue: v, shares: 0n, shareDecimals: 18, assets: 0 };
    const dec = await read<number>(ctx, v.address, "decimals");
    const bal = await read<bigint>(ctx, v.address, "balanceOf", [user]);
    return { venue: v, shares: bal, shareDecimals: dec, assets: human(bal, dec) };
  }
  const shareToken = v.share ?? v.address;
  const [dec, shares] = await Promise.all([read<number>(ctx, shareToken, "decimals"), read<bigint>(ctx, shareToken, "balanceOf", [user])]);
  const assets = shares ? human(await read<bigint>(ctx, v.address, "convertToAssets", [shares])) : 0;
  const p: Position & { claimableDepositRaw?: bigint; claimableRedeemRaw?: bigint } = { venue: v, shares, shareDecimals: dec, assets };
  if (v.kind !== "vault-v2" && v.kind !== "r25-sync") {
    const ids = [...new Set([0n, ...requestIds])];
    const sum = async (fn: string) => (await Promise.all(ids.map((id) => maybe<bigint>(ctx, v.address, fn, [id, user])))).reduce<bigint>((a, b) => a + (b ?? 0n), 0n);
    const [pd, cd, pr, cr] = await Promise.all([sum("pendingDepositRequest"), sum("claimableDepositRequest"), sum("pendingRedeemRequest"), sum("claimableRedeemRequest")]);
    if (pd) p.pendingDeposit = human(pd);
    if (cd) {
      p.claimableDeposit = human(cd);
      p.claimableDepositRaw = cd;
    }
    if (pr) p.pendingRedeem = human(pr, dec);
    if (cr) {
      p.claimableRedeem = human(cr, dec);
      p.claimableRedeemRaw = cr;
    }
  }
  return p;
}

/** Shares to redeem for `amount` USDC (base units), or all of them. */
export async function sharesFor(ctx: Ctx, v: Venue, user: Address, amount: bigint | "all"): Promise<bigint> {
  const bal = await read<bigint>(ctx, v.share ?? v.address, "balanceOf", [user]);
  if (amount === "all") return bal;
  const s = await read<bigint>(ctx, v.address, "convertToShares", [amount]);
  return s + 1n > bal ? bal : s + 1n;
}

