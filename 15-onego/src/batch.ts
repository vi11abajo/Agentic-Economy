// Packs a plan into one Multicall3 aggregate3Value call. Nothing here asks the wallet for rights: PROS goes
// along with each call, USDC moves only by the payer's own EIP-3009 signatures, and every bought token is
// addressed straight to the wallet. After the actions come read-backs, so the same call also tells us who
// holds what afterwards, Multicall3 included (it must end up holding nothing).
import { encodeFunctionData, parseSignature, type Address, type Hex, type LocalAccount } from "viem";
import { MULTICALL3, USDC, USDC_DECIMALS, USDC_DOMAIN, WPROS, erc20Abi, marketAbi, multicall3Abi, pairAbi, usdcAuthAbi, wprosAbi } from "./book.js";
import type { Venue } from "./market.js";
import { toUnits, type Plan } from "./plan.js";

export type Call3Value = { target: Address; allowFailure: boolean; value: bigint; callData: Hex };
/** What a read-back measures: how much of `asset` (a token, or "PROS") `holder` has after the batch. */
export type Reading = { holder: Address; asset: Address | "PROS"; symbol: string; decimals: number };
export type Step = { action: number; label: string; call: Call3Value; reads?: Reading };
export type Authorization = { action: number; to: Address; value: bigint; validBefore: bigint; nonce: Hex; signature: Hex };

export const AUTH_WINDOW_SEC = 900n; // a signed payment that wasn't used is dead 15 minutes later
const DEADLINE_SEC = 900n;

export const TRANSFER_WITH_AUTHORIZATION = [
  { name: "from", type: "address" },
  { name: "to", type: "address" },
  { name: "value", type: "uint256" },
  { name: "validAfter", type: "uint256" },
  { name: "validBefore", type: "uint256" },
  { name: "nonce", type: "bytes32" },
] as const;

export type BatchInput = {
  plan: Plan;
  venues: Map<number, Venue>;
  quotes: Map<number, { value: bigint; out: bigint }>;
  signer: LocalAccount;
  now: bigint;
  nonceFor: (i: number) => Hex;
};

export async function buildBatch(input: BatchInput): Promise<{ steps: Step[]; readBacks: Step[]; value: bigint; authorizations: Authorization[] }> {
  const { plan, venues, quotes, signer, now, nonceFor } = input;
  const steps: Step[] = [];
  const authorizations: Authorization[] = [];
  const readBacks: Step[] = [];
  const watched = new Map<string, Reading>();
  const watch = (r: Reading) => watched.set(`${r.holder}|${r.asset}`.toLowerCase(), r);

  for (const [i, a] of plan.actions.entries()) {
    if (a.kind === "send_pros") {
      steps.push({ action: i, label: `send ${a.amount} PROS to ${a.to}`, call: { target: a.to, allowFailure: false, value: toUnits(a.amount, 18), callData: "0x" } });
      watch({ holder: a.to, asset: "PROS", symbol: "PROS", decimals: 18 });
    } else if (a.kind === "send_usdc") {
      const value = toUnits(a.amount, USDC_DECIMALS);
      const validBefore = now + AUTH_WINDOW_SEC;
      const nonce = nonceFor(i);
      const signature = await signer.signTypedData({ domain: USDC_DOMAIN, types: { TransferWithAuthorization: TRANSFER_WITH_AUTHORIZATION }, primaryType: "TransferWithAuthorization", message: { from: signer.address, to: a.to, value, validAfter: 0n, validBefore, nonce } });
      const { r, s, v, yParity } = parseSignature(signature);
      const callData = encodeFunctionData({ abi: usdcAuthAbi, functionName: "transferWithAuthorization", args: [signer.address, a.to, value, 0n, validBefore, nonce, Number(v ?? BigInt(yParity + 27)), r, s] });
      steps.push({ action: i, label: `send ${a.amount} USDC to ${a.to}`, call: { target: USDC, allowFailure: true, value: 0n, callData } });
      authorizations.push({ action: i, to: a.to, value, validBefore, nonce, signature });
      watch({ holder: a.to, asset: USDC, symbol: "USDC", decimals: USDC_DECIMALS });
    } else {
      const venue = venues.get(i);
      const quote = quotes.get(i);
      if (!venue || !quote) throw new Error(`action ${i + 1}: no venue or quote for ${a.token}`);
      if (venue.kind === "pool") {
        // wrap -> pay the pool -> the pool sends the tokens to the wallet. Multicall3 only ever spends WPROS it
        // minted a moment earlier in this same call.
        const swapArgs: [bigint, bigint, Address, Hex] = venue.wprosIs0 ? [0n, quote.out, plan.wallet, "0x"] : [quote.out, 0n, plan.wallet, "0x"];
        steps.push(
          { action: i, label: `wrap ${a.pros} PROS for ${venue.symbol}`, call: { target: WPROS, allowFailure: false, value: quote.value, callData: encodeFunctionData({ abi: wprosAbi, functionName: "deposit" }) } },
          { action: i, label: `pay the ${venue.symbol} pool`, call: { target: WPROS, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [venue.pair, quote.value] }) } },
          { action: i, label: `buy ${venue.symbol} for ${a.pros} PROS`, call: { target: venue.pair, allowFailure: false, value: 0n, callData: encodeFunctionData({ abi: pairAbi, functionName: "swap", args: swapArgs }) } },
        );
        watch({ holder: plan.wallet, asset: WPROS, symbol: "WPROS", decimals: 18 });
        watch({ holder: MULTICALL3, asset: WPROS, symbol: "WPROS", decimals: 18 });
      } else {
        // The market takes a recipient, so the tokens never touch Multicall3. The router's buy would send them to
        // msg.sender, which here is Multicall3, where anyone could take them: that's why we skip the router.
        const callData = encodeFunctionData({ abi: marketAbi, functionName: "buyNative", args: [quote.out, now + DEADLINE_SEC, plan.wallet] });
        steps.push({ action: i, label: `buy ${venue.symbol} for ${a.pros} PROS on its curve`, call: { target: venue.market, allowFailure: false, value: quote.value, callData } });
      }
      watch({ holder: plan.wallet, asset: venue.token, symbol: venue.symbol, decimals: 18 });
      watch({ holder: MULTICALL3, asset: venue.token, symbol: venue.symbol, decimals: 18 });
    }
  }
  watch({ holder: MULTICALL3, asset: "PROS", symbol: "PROS", decimals: 18 });

  for (const r of watched.values()) {
    const callData =
      r.asset === "PROS"
        ? encodeFunctionData({ abi: multicall3Abi, functionName: "getEthBalance", args: [r.holder] })
        : encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [r.holder] });
    readBacks.push({ action: -1, label: `${r.symbol} held by ${r.holder}`, reads: r, call: { target: r.asset === "PROS" ? MULTICALL3 : r.asset, allowFailure: true, value: 0n, callData } });
  }
  return { steps, readBacks, value: steps.reduce((sum, s) => sum + s.call.value, 0n), authorizations };
}

export const encodeBatch = (steps: Step[]): Hex => encodeFunctionData({ abi: multicall3Abi, functionName: "aggregate3Value", args: [steps.map((s) => s.call)] });

/** The calldata that really goes on chain: the actions only. Read-backs are for simulations, not worth paying for. */
export const sentData = (b: { steps: Step[] }): Hex => encodeBatch(b.steps);
