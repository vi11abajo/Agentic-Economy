// A plan is what the agent makes out of the user's words: who pays, and a list of independent actions. Here we
// only check it's sane. Every problem is collected, so the agent can fix them all in one go.
import { getAddress, isAddress, type Address } from "viem";
import { USDC_DECIMALS } from "./book.js";

export type Action =
  | { kind: "send_pros"; to: Address; amount: string }
  | { kind: "send_usdc"; to: Address; amount: string }
  | { kind: "buy"; token: string; pros: string; market?: Address };
export type Plan = { wallet: Address; actions: Action[] };

// Things people will ask for that would need the wallet to approve someone first. onego doesn't do that, ever.
const NEEDS_APPROVE: Record<string, string> = {
  sell: "selling a token means a pool or router pulls it from the wallet, which needs an approve",
  swap: "swapping an ERC-20 means someone pulls it from the wallet, which needs an approve",
  send_token: "sending a token without EIP-3009 from inside a batch needs an approve to the batcher",
};

/** "0.00001" with 6 decimals -> 10n. Refuses what it can't count exactly instead of rounding it away. */
export function toUnits(amount: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(amount.trim())) throw new Error(`"${amount}" is not an amount`);
  const [whole, frac = ""] = amount.trim().split(".");
  if (frac.length > decimals) throw new Error(`"${amount}" has more digits than the token's ${decimals} decimals`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, "0") || "0");
  if (units === 0n) throw new Error(`"${amount}" must be more than zero`);
  return units;
}

export function parsePlan(json: unknown): { plan: Plan } | { problems: string[] } {
  const problems: string[] = [];
  const raw = (json ?? {}) as { wallet?: unknown; actions?: unknown };
  const wallet = typeof raw.wallet === "string" && isAddress(raw.wallet) ? getAddress(raw.wallet) : null;
  if (!wallet) problems.push(`the wallet "${String(raw.wallet)}" is not an address`);
  const list = Array.isArray(raw.actions) ? raw.actions : [];
  if (list.length === 0) problems.push("the plan has no actions");

  const actions: Action[] = [];
  const paid = new Set<string>();
  list.forEach((a: Record<string, unknown>, i) => {
    const say = (what: string) => problems.push(`action ${i + 1}: ${what}`);
    const kind = String(a?.kind);
    const amountOk = (amount: unknown, decimals: number) => {
      try {
        toUnits(String(amount), decimals);
        return true;
      } catch (err) {
        say((err as Error).message);
        return false;
      }
    };
    if (kind === "send_pros" || kind === "send_usdc") {
      const to = typeof a.to === "string" && isAddress(a.to) ? getAddress(a.to) : null;
      if (!to) return say(`"${String(a.to)}" is not an address`);
      if (wallet && to === wallet) return say("that's the wallet itself");
      const key = `${kind} ${to}`;
      if (paid.has(key)) return say(`${to} is paid twice`);
      paid.add(key);
      if (amountOk(a.amount, kind === "send_usdc" ? USDC_DECIMALS : 18)) actions.push({ kind, to, amount: String(a.amount) });
    } else if (kind === "buy") {
      if (typeof a.token !== "string" || !a.token) return say("which token to buy?");
      const market = typeof a.market === "string" && isAddress(a.market) ? getAddress(a.market) : undefined;
      if (amountOk(a.pros, 18)) actions.push({ kind, token: a.token, pros: String(a.pros), ...(market ? { market } : {}) });
    } else if (NEEDS_APPROVE[kind]) {
      say(`can't ${kind}: ${NEEDS_APPROVE[kind]}, and onego never gives anyone rights to the wallet`);
    } else {
      say(`unknown kind "${kind}" (onego does send_pros, send_usdc and buy)`);
    }
  });
  return problems.length || !wallet ? { problems } : { plan: { wallet, actions } };
}
