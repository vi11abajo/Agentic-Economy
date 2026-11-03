// The honest comparison: the same actions sent one transaction at a time from the wallet, each estimated by the
// node. A pool buy without a batcher is three transactions (wrap, pay the pool, swap): the Prosper router has no
// one-transaction buy for graduated tokens that we could find (checked 2026-11-03).
import { encodeFunctionData, toHex, type Address } from "viem";
import { USDC, USDC_DECIMALS, USDC_SLOT, WPROS, WPROS_SLOT, erc20Abi, marketAbi, pairAbi, wprosAbi } from "./book.js";
import { mapSlot, type Chain, type Overrides, type TxReq } from "./chain.js";
import type { Venue } from "./market.js";
import { toUnits, type Plan } from "./plan.js";

const PLENTY = 10n ** 27n;
const pad32 = (n: bigint) => toHex(n, { size: 32 });

export async function oneByOne(chain: Chain, plan: Plan, venues: Map<number, Venue>, quotes: Map<number, { value: bigint; out: bigint }>): Promise<{ txs: number; gas: bigint }> {
  const me = plan.wallet;
  const rich: Overrides = { [me]: { balance: toHex(PLENTY) } };
  const singles: Array<{ tx: TxReq; o: Overrides }> = [];
  const deadline = 4_102_444_800n; // 2100-01-01: the estimate shouldn't care about the clock

  for (const [i, a] of plan.actions.entries()) {
    if (a.kind === "send_pros") singles.push({ tx: { from: me, to: a.to, data: "0x", value: toUnits(a.amount, 18) }, o: rich });
    else if (a.kind === "send_usdc")
      singles.push({ tx: { from: me, to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [a.to, toUnits(a.amount, USDC_DECIMALS)] }) }, o: { ...rich, [USDC]: { stateDiff: { [mapSlot(me, USDC_SLOT)]: pad32(PLENTY) } } } });
    else {
      const v = venues.get(i)!;
      const q = quotes.get(i)!;
      if (v.kind === "curve") {
        singles.push({ tx: { from: me, to: v.market, value: q.value, data: encodeFunctionData({ abi: marketAbi, functionName: "buyNative", args: [q.out, deadline, me] }) }, o: rich });
        continue;
      }
      const inPool = await chain.call({ to: WPROS, data: encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [v.pair] }) });
      if (!inPool.ok) throw new Error(`couldn't read the ${v.symbol} pool's WPROS: ${inPool.message}`);
      const swapArgs: [bigint, bigint, Address, `0x${string}`] = v.wprosIs0 ? [0n, q.out, me, "0x"] : [q.out, 0n, me, "0x"];
      singles.push(
        { tx: { from: me, to: WPROS, value: q.value, data: encodeFunctionData({ abi: wprosAbi, functionName: "deposit" }) }, o: rich },
        { tx: { from: me, to: WPROS, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [v.pair, q.value] }) }, o: { ...rich, [WPROS]: { stateDiff: { [mapSlot(me, WPROS_SLOT)]: pad32(q.value) } } } },
        // the swap as if the WPROS had already landed in the pool (the previous transaction)
        { tx: { from: me, to: v.pair, data: encodeFunctionData({ abi: pairAbi, functionName: "swap", args: swapArgs }) }, o: { ...rich, [WPROS]: { stateDiff: { [mapSlot(v.pair, WPROS_SLOT)]: pad32(BigInt(inPool.data) + q.value) } } } },
      );
    }
  }

  let gas = 0n;
  for (const s of singles) {
    const g = await chain.estimateGas(s.tx, s.o);
    if (g === null) throw new Error(`couldn't estimate a single transaction to ${s.tx.to} for the comparison`);
    gas += g;
  }
  return { txs: singles.length, gas };
}
