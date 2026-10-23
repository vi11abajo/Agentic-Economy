// The rotation saga: get out of one Prosper curve token (A) and into another (B).
//   1 approve  A -> Prosper router            undo: put the allowance back as it was
//   2 sell     A on its curve, for WPROS       undo: unwrap what's left, buy A back with the PROS
//   3 unwrap   WPROS -> PROS                   undo: none (buying A back needs PROS anyway)
//   4 buy      B on its curve, for PROS        last step
// Each step reads fresh state to build its transaction (quotes, balances, a new deadline) and checks the
// receipt's events and the balances afterwards. The "enter" saga is just step 4, to get a first bag.
import { decodeEventLog, encodeFunctionData, formatEther, type Address } from "viem";
import { ROUTER, WPROS, curveEvents, erc20Abi, routerAbi, wprosAbi } from "./prosper.js";
import type { Action, Receipt, Step, TxSpec } from "./saga.js";

export interface Token {
  market: Address;
  token: Address;
  symbol: string;
}

/** Reads the chain needs to build and check the steps. */
export interface Reader {
  /** at: read at that block (verification reads before and after the receipt's block, so a lagging RPC
   *  node behind a load balancer can't make a done step look undone). */
  tokenBalance(token: Address, owner: Address, at?: bigint): Promise<bigint>;
  allowance(token: Address, owner: Address, spender: Address, at?: bigint): Promise<bigint>;
  quoteSell(market: Address, tokens: bigint): Promise<bigint>; // net WPROS out
  quoteBuy(market: Address, pros: bigint): Promise<bigint>; // tokens out
  now(): Promise<bigint>; // latest block timestamp
}

export interface RotationCtx {
  me: Address;
  a?: Token;
  b: Token;
  sellAmount: bigint;
  slippageBps: number;
  maxBuy: bigint;
  /** enter saga: PROS to spend on B. */
  enterValue?: bigint;
  prevAllowance?: bigint;
  wprosBefore?: bigint;
  prosOut?: bigint;
  wprosBeforeUnwrap?: bigint;
  leftover?: bigint;
  unwrapped?: bigint;
  buyValue?: bigint;
  bBefore?: bigint;
  boughtB?: bigint;
  aBefore?: bigint;
  rebought?: bigint;
}

const SABOTAGE_GAS = 600_000n; // a sabotaged call reverts in estimation, so it gets a fixed limit
export const pros = (wei: bigint) => `${Number(formatEther(wei)).toPrecision(4)} PROS`;
export const amt = (wei: bigint, sym: string) => `${Math.round(Number(formatEther(wei))).toLocaleString("en-US")} ${sym}`;
const less = (x: bigint, bps: number) => (x * BigInt(10_000 - bps)) / 10_000n;

function tradeEvent(r: Receipt, market: Address, me: Address, name: "Bought" | "Sold") {
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== market.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: curveEvents, data: log.data, topics: log.topics });
      const a = ev.args as unknown as Record<string, bigint | string>;
      if (ev.eventName === name && (a.trader as string).toLowerCase() === me.toLowerCase()) return a;
    } catch {
      // another event in the same transaction
    }
  }
  throw new Error(`no ${name} event for ${me} from market ${market}`);
}

export function rotationSteps(r: Reader): Step<RotationCtx>[] {
  const restoreAllowance: Action<RotationCtx> = {
    name: "restore-allowance",
    async plan(c) {
      const now = await r.allowance(c.a!.token, c.me, ROUTER);
      if (now === (c.prevAllowance ?? 0n)) return null;
      return { to: c.a!.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, c.prevAllowance ?? 0n] }) };
    },
    async verify(c, _chain, rc) {
      const now = await r.allowance(c.a!.token, c.me, ROUTER, rc?.block);
      if (now !== (c.prevAllowance ?? 0n)) throw new Error(`allowance is ${now}, expected ${c.prevAllowance}`);
      return `router allowance for ${c.a!.symbol} back to ${c.prevAllowance ?? 0n}`;
    },
  };

  const unwrapLeftover: Action<RotationCtx> = {
    name: "unwrap-leftover",
    async plan(c) {
      if (!c.prosOut) return null; // the sale never happened
      // Look at the wallet, not at what the saga remembers: the unwrap may have gone through even if the
      // saga never got to verify it.
      c.wprosBeforeUnwrap = await r.tokenBalance(WPROS, c.me);
      const left = c.wprosBeforeUnwrap < c.prosOut ? c.wprosBeforeUnwrap : c.prosOut;
      if (left === 0n) return null;
      c.leftover = left;
      return { to: WPROS, data: encodeFunctionData({ abi: wprosAbi, functionName: "withdraw", args: [left] }) };
    },
    async verify(c, _chain, rc) {
      if (!rc) return "the sale's WPROS is already PROS";
      const drop = (await r.tokenBalance(WPROS, c.me, rc.block - 1n)) - (await r.tokenBalance(WPROS, c.me, rc.block));
      if (drop !== c.leftover!) throw new Error(`WPROS balance dropped by ${drop}, expected ${c.leftover}`);
      return `unwrapped ${pros(c.leftover!)}`;
    },
  };

  const rebuyA: Action<RotationCtx> = {
    name: "buy-back",
    async plan(c) {
      if (!c.prosOut) return null; // the sale never happened
      const out = await r.quoteBuy(c.a!.market, c.prosOut);
      c.aBefore = await r.tokenBalance(c.a!.token, c.me);
      const deadline = (await r.now()) + 300n;
      return { to: ROUTER, value: c.prosOut, data: encodeFunctionData({ abi: routerAbi, functionName: "buyInnerNative", args: [c.a!.market, less(out, c.slippageBps), deadline] }) };
    },
    async verify(c, _chain, rc) {
      if (!rc) return "nothing to buy back";
      const ev = tradeEvent(rc, c.a!.market, c.me, "Bought");
      const gain = (await r.tokenBalance(c.a!.token, c.me, rc.block)) - (await r.tokenBalance(c.a!.token, c.me, rc.block - 1n));
      if (gain !== (ev.pTokenOut as bigint)) throw new Error(`${c.a!.symbol} balance grew by ${gain}, the Bought event says ${ev.pTokenOut}`);
      c.rebought = ev.pTokenOut as bigint;
      return `bought back ${amt(c.rebought, c.a!.symbol)} for ${pros(c.prosOut!)} (sold ${amt(c.sellAmount, c.a!.symbol)}; the gap is the curve's 1% fee each way)`;
    },
  };

  return [
    {
      name: "approve",
      title: "Approve the Prosper router to take A",
      async plan(c) {
        const now = await r.allowance(c.a!.token, c.me, ROUTER);
        if (c.prevAllowance === undefined) c.prevAllowance = now;
        if (now >= c.sellAmount) return null;
        return { to: c.a!.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [ROUTER, c.sellAmount] }) };
      },
      async verify(c, _chain, rc) {
        const now = await r.allowance(c.a!.token, c.me, ROUTER, rc?.block);
        if (now < c.sellAmount) throw new Error(`allowance ${now} is below ${c.sellAmount}`);
        return rc ? `router may take ${amt(c.sellAmount, c.a!.symbol)}` : "router was already approved";
      },
      compensate: [restoreAllowance],
    },
    {
      name: "sell",
      title: "Sell A on its curve for WPROS",
      async plan(c, _chain, { sabotage }) {
        const out = await r.quoteSell(c.a!.market, c.sellAmount);
        c.wprosBefore = await r.tokenBalance(WPROS, c.me);
        const deadline = (await r.now()) + 300n;
        const minOut = sabotage ? out * 10n : less(out, c.slippageBps);
        const tx: TxSpec = { to: ROUTER, data: encodeFunctionData({ abi: routerAbi, functionName: "sellInner", args: [c.a!.market, c.sellAmount, minOut, deadline, false] }) };
        return sabotage ? { ...tx, gas: SABOTAGE_GAS } : tx;
      },
      async verify(c, _chain, rc) {
        const ev = tradeEvent(rc!, c.a!.market, c.me, "Sold");
        const gain = (await r.tokenBalance(WPROS, c.me, rc!.block)) - (await r.tokenBalance(WPROS, c.me, rc!.block - 1n));
        if (gain !== (ev.netOut as bigint)) throw new Error(`WPROS balance grew by ${gain}, the Sold event says ${ev.netOut}`);
        c.prosOut = ev.netOut as bigint;
        return `sold ${amt(ev.pTokenIn as bigint, c.a!.symbol)} for ${pros(c.prosOut)} (WPROS)`;
      },
      compensate: [unwrapLeftover, rebuyA],
    },
    {
      name: "unwrap",
      title: "Unwrap WPROS to PROS",
      async plan(c) {
        c.wprosBeforeUnwrap = await r.tokenBalance(WPROS, c.me);
        return { to: WPROS, data: encodeFunctionData({ abi: wprosAbi, functionName: "withdraw", args: [c.prosOut!] }) };
      },
      async verify(c, _chain, rc) {
        const drop = (await r.tokenBalance(WPROS, c.me, rc!.block - 1n)) - (await r.tokenBalance(WPROS, c.me, rc!.block));
        if (drop !== c.prosOut!) throw new Error(`WPROS balance dropped by ${drop}, expected ${c.prosOut}`);
        c.unwrapped = c.prosOut;
        return `unwrapped ${pros(c.unwrapped!)}`;
      },
      compensate: [],
      noCompensationBecause: "buying A back needs PROS, so the PROS stays as it is",
    },
    buyStep(r, "Buy B on its curve with the PROS", (c) => c.unwrapped!),
  ];
}

/** Buy B with PROS. In a rotation it spends what the sale brought (capped by maxBuy); in "enter" a set amount. */
export function buyStep(r: Reader, title: string, value: (c: RotationCtx) => bigint): Step<RotationCtx> {
  return {
    name: "buy",
    title,
    async plan(c, _chain, { sabotage }) {
      const v = value(c) < c.maxBuy ? value(c) : c.maxBuy;
      c.buyValue = v;
      const out = await r.quoteBuy(c.b.market, v);
      c.bBefore = await r.tokenBalance(c.b.token, c.me);
      const deadline = (await r.now()) + 300n;
      const minOut = sabotage ? out * 10n : less(out, c.slippageBps);
      const tx: TxSpec = { to: ROUTER, value: v, data: encodeFunctionData({ abi: routerAbi, functionName: "buyInnerNative", args: [c.b.market, minOut, deadline] }) };
      return sabotage ? { ...tx, gas: SABOTAGE_GAS } : tx;
    },
    async verify(c, _chain, rc) {
      const ev = tradeEvent(rc!, c.b.market, c.me, "Bought");
      const gain = (await r.tokenBalance(c.b.token, c.me, rc!.block)) - (await r.tokenBalance(c.b.token, c.me, rc!.block - 1n));
      if (gain !== (ev.pTokenOut as bigint)) throw new Error(`${c.b.symbol} balance grew by ${gain}, the Bought event says ${ev.pTokenOut}`);
      c.boughtB = ev.pTokenOut as bigint;
      return `bought ${amt(c.boughtB, c.b.symbol)} for ${pros(c.buyValue!)}`;
    },
    compensate: [],
    noCompensationBecause: "it is the last step: nothing after it can fail",
  };
}
