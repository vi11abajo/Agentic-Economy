// The chain side: reads at one pinned block, simulations with state overrides, and sending. Everything goes to
// the public Pharos RPC. It is load-balanced and rate-limited, so reads are retried and pinned to a block that
// every node already has.
import {
  concat,
  createPublicClient,
  custom,
  decodeErrorResult,
  defineChain,
  keccak256,
  pad,
  parseAbi,
  toHex,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
  type StateOverride,
} from "viem";

export const RPC_URL = process.env.HARBORPILOT_RPC || "https://rpc.pharos.xyz";
export const EXPLORER = "https://www.pharosscan.xyz";

export const pharos = defineChain({
  id: 1672,
  name: "Pharos",
  nativeCurrency: { name: "PROS", symbol: "PROS", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const USDC: Address = "0xC879C018dB60520F4355C26eD1a6D572cdAC1815";
export const WPROS: Address = "0x52C48d4213107b20bC583832b0d951FB9CA8F0B0";

/** Storage slots of balanceOf / allowance (Solidity mappings), found by writing a slot and reading it back. */
export const TOKEN_SLOTS: Record<string, { balance: number; allowance: number }> = {
  [USDC.toLowerCase()]: { balance: 9, allowance: 10 },
  [WPROS.toLowerCase()]: { balance: 3, allowance: 4 },
};

const LIMITED = /too fast|cu limit|rate limit|too many|try again|busy|header not found|unknown block|cannot be greater/i;

/**
 * JSON-RPC over fetch with a cap on requests in flight and a retry with backoff when the node says it's
 * throttled (its errors for that have no standard code, so viem's own retry doesn't catch them).
 */
export function rpcRequest(url: string, maxInFlight = 6) {
  let inFlight = 0;
  const queue: (() => void)[] = [];
  const acquire = () => (inFlight < maxInFlight ? (inFlight++, Promise.resolve()) : new Promise<void>((r) => queue.push(() => (inFlight++, r()))));
  const release = () => {
    inFlight--;
    queue.shift()?.();
  };
  let id = 0;
  return async ({ method, params }: { method: string; params?: unknown }): Promise<unknown> => {
    for (let attempt = 0; ; attempt++) {
      await acquire();
      let j: { result?: unknown; error?: { code: number; message: string; data?: unknown } } | null = null;
      let netErr: string | undefined;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await res.text();
        try {
          j = JSON.parse(text);
        } catch {
          netErr = `HTTP ${res.status}: ${text.slice(0, 120)}`;
        }
      } catch (e) {
        netErr = (e as Error).message;
      } finally {
        release();
      }
      if (process.env.HARBORPILOT_DEBUG && (netErr || j?.error)) console.error(`[rpc] ${method} attempt ${attempt}: ${netErr ?? JSON.stringify(j?.error)}`);
      const retry = netErr !== undefined || (j?.error && LIMITED.test(j.error.message ?? ""));
      if (!retry) {
        if (j?.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
        return j?.result;
      }
      if (attempt >= 7) throw new Error(`${method}: the RPC kept failing (${netErr ?? j?.error?.message})`);
      await new Promise((r) => setTimeout(r, 400 * 2 ** Math.min(attempt, 4) + Math.random() * 300));
    }
  };
}

export function makeClient(url = RPC_URL): PublicClient {
  return createPublicClient({
    chain: pharos,
    transport: custom({ request: rpcRequest(url) }, { retryCount: 0 }),
    batch: { multicall: { wait: 16 } },
  }) as PublicClient;
}

/** One unsigned transaction of a plan. */
export interface Step {
  label: string;
  to: Address;
  data: Hex;
  value: bigint;
  /** What this step leaves behind (an allowance, a balance), so the next step can be simulated before it lands. */
  after?: StateOverride;
}

export type SimResult = { ok: true; data: Hex } | { ok: false; reason: string };

const slot32 = (n: bigint | number) => pad(toHex(n), { size: 32 });
const mapSlot = (key: Hex, slot: bigint | number) => keccak256(concat([pad(key, { size: 32 }), slot32(slot)]));

/** State overrides for a token: give `holder` a balance and an allowance to `spender`. */
export function tokenOverride(token: Address, holder: Address, o: { balance?: bigint; spender?: Address; allowance?: bigint }): StateOverride {
  const s = TOKEN_SLOTS[token.toLowerCase()];
  if (!s) return [];
  const diff: { slot: Hex; value: Hex }[] = [];
  if (o.balance !== undefined) diff.push({ slot: mapSlot(holder, s.balance), value: slot32(o.balance) });
  if (o.spender && o.allowance !== undefined) {
    diff.push({ slot: keccak256(concat([pad(o.spender, { size: 32 }), mapSlot(holder, s.allowance)])), value: slot32(o.allowance) });
  }
  return [{ address: token, stateDiff: diff }];
}

/** Morpho Blue keeps position[id][user] at slot 2: supplyShares, then borrowShares (low 128) | collateral (high 128). */
export function morphoCollateralOverride(morpho: Address, id: Hex, user: Address, collateral: bigint, borrowShares = 0n): StateOverride {
  const base = BigInt(keccak256(concat([pad(user, { size: 32 }), keccak256(concat([id, slot32(2)]))])));
  return [{ address: morpho, stateDiff: [{ slot: slot32(base + 1n), value: slot32((collateral << 128n) | borrowShares) }] }];
}

/** Merge overrides of the same account (viem wants one entry per address). */
export function mergeOverrides(...all: StateOverride[]): StateOverride {
  const by = new Map<string, { address: Address; stateDiff: { slot: Hex; value: Hex }[] }>();
  for (const o of all.flat()) {
    const k = o.address.toLowerCase();
    const diff = [...(o.stateDiff ?? [])];
    const prev = by.get(k);
    if (!prev) by.set(k, { address: o.address, stateDiff: diff });
    else prev.stateDiff.push(...diff);
  }
  return [...by.values()];
}

/** Custom errors seen on the Harbor vaults, so a revert reads as a reason, not as a selector. */
export const ERRORS = parseAbi([
  "error BelowMinDeposit(uint256 amount, uint256 min)",
  "error BelowMinDeposit(address user, uint256 amount, uint256 min)",
  "error BelowMinimumRequest()",
  "error InsufficientAmount()",
  "error InsufficientNativeFee(uint256 sent, uint256 needed)",
  "error InsufficientUnlockedShares(uint256 requested, uint256 unlocked)",
  "error InsufficientShares()",
  "error NotInWhitelist(address user)",
  "error OperationPaused()",
  "error UseRedeemShares()",
  "error Unauthorized()",
  "error TransferNotAllowed()",
  "error ExceedsMaxDeposit()",
  "error NotSupported()",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
]);

const PLAIN: Record<string, string> = {
  BelowMinDeposit: "below the vault's minimum deposit",
  BelowMinimumRequest: "below the vault's minimum request",
  InsufficientAmount: "below the vault's minimum deposit",
  InsufficientNativeFee: "the call needs a PROS fee",
  InsufficientUnlockedShares: "the shares are still locked",
  NotInWhitelist: "this address is not on the vault's whitelist",
  OperationPaused: "the vault is paused",
  Unauthorized: "only addresses with a role can deposit",
  TransferNotAllowed: "members only (KYB)",
  ExceedsMaxDeposit: "the vault accepts nothing from this address (members only)",
};

/** Turn revert data (or the node's message) into one readable line. */
export function explainRevert(data: Hex | undefined, message = "reverted"): string {
  if (data && data.length >= 10) {
    try {
      const e = decodeErrorResult({ abi: [...ERRORS, ...parseAbi(["error Error(string)", "error Panic(uint256)"])] as Abi, data });
      if (e.errorName === "Error") return String(e.args?.[0]);
      if (e.errorName === "Panic") return `panic ${String(e.args?.[0])}`;
      const args = e.args?.length ? `(${e.args.map(String).join(", ")})` : "";
      return PLAIN[e.errorName] ? `${PLAIN[e.errorName]}: ${e.errorName}${args}` : `${e.errorName}${args}`;
    } catch {
      return `custom error ${data.slice(0, 10)}`;
    }
  }
  const m = message.replace(/^execution reverted:?\s*/i, "").trim();
  return m || "reverted with no reason";
}

function revertData(e: unknown): { data?: Hex; message: string } {
  let cur: unknown = e;
  let message = (e as Error)?.message ?? String(e);
  for (let i = 0; i < 6 && cur; i++) {
    const c = cur as { data?: unknown; shortMessage?: string; details?: string; cause?: unknown };
    if (typeof c.data === "string" && c.data.startsWith("0x")) return { data: c.data as Hex, message: c.details ?? message };
    if (c.data && typeof c.data === "object" && typeof (c.data as { data?: unknown }).data === "string") {
      return { data: (c.data as { data: Hex }).data, message };
    }
    if (c.details) message = c.details;
    cur = c.cause;
  }
  return { message };
}

const NETWORK = /fetch failed|timed? ?out|ECONN|socket|429|too fast|cu limit|rate limit|HTTP request failed|header not found|unknown block/i;

/** eth_call of a step from `from`, with optional state overrides. A network failure throws; a revert doesn't. */
export async function simulate(client: PublicClient, from: Address, step: Step, stateOverride?: StateOverride, block?: bigint): Promise<SimResult> {
  try {
    const r = await client.call({ account: from, to: step.to, data: step.data, value: step.value, stateOverride, ...(block ? { blockNumber: block } : {}) });
    return { ok: true, data: r.data ?? "0x" };
  } catch (e) {
    const r = revertData(e);
    if (!r.data && NETWORK.test(r.message)) throw e;
    return { ok: false, reason: explainRevert(r.data, r.message) };
  }
}

/** The block to read at: one behind the head, so every node behind the load balancer has it. */
export async function pinnedBlock(client: PublicClient): Promise<{ block: bigint; time: bigint }> {
  const head = await client.getBlockNumber({ cacheTime: 0 });
  const b = await client.getBlock({ blockNumber: head - 1n });
  return { block: b.number, time: b.timestamp };
}

/** Block numbers about `days` ago, from the average block time over the last million blocks. */
export async function blocksAgo(client: PublicClient, now: { block: bigint; time: bigint }, days: number[]): Promise<Map<number, { block: bigint; time: bigint }>> {
  const span = 1_000_000n;
  const past = await client.getBlock({ blockNumber: now.block - span });
  const perSec = Number(span) / Number(now.time - past.timestamp);
  const out = new Map<number, { block: bigint; time: bigint }>();
  await Promise.all(
    days.map(async (d) => {
      const n = now.block - BigInt(Math.round(d * 86400 * perSec));
      if (n <= 0n) return;
      const b = await client.getBlock({ blockNumber: n });
      out.set(d, { block: b.number, time: b.timestamp });
    }),
  );
  return out;
}

/** Run with a deadline; the venue that doesn't answer in time is reported as down, the others carry on. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: no answer in ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
