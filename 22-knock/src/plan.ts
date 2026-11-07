// From a parsed sentence to something a wallet can sign. Every check here is a read against the chain at the
// latest block, and every one lands in the verdict list, so the summary can show what was looked at and not only
// what failed. One BLOCK and there is no plan; WARNs ride along in the summary.
import {
  decodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  getAddress,
  isAddress,
  parseAbi,
  parseSignature,
  parseUnits,
  toHex,
  type Hex,
} from "viem";
import { accountFacts, describe, short, type AccountFacts } from "./account.js";
import type { Chain } from "./chain.js";
import { resolveName, type NameCheck, type Resolver, type Verdict } from "./names.js";
import type { Intent } from "./parse.js";
import { outcome, recipientVerdicts, transferTx, type Outcome } from "./recipient.js";
import { findBySymbol, PHAROS_CHAIN_ID, REGISTRY, USDC, type Token } from "./registry.js";

export const RECEIVE_ABI = parseAbi([
  "function receiveWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s)",
]);
const AUTH_WINDOW_SECONDS = 3600;

export interface Authorization {
  typedData: object;
  validBefore: number;
  nonce: Hex;
  payee: Hex;
}

export interface Plan {
  createdAt: string;
  block: number;
  intent: Intent;
  from: Hex;
  to: Hex;
  name?: string;
  token: Token;
  amount: string;
  raw: string;
  verdicts: Verdict[];
  recipient: string;
  maxFeePros: string;
  balanceAfter: string;
  tx: {
    chainId: typeof PHAROS_CHAIN_ID;
    type: "0x2";
    from: Hex;
    to: Hex;
    data: Hex;
    value: Hex;
    gas: Hex;
    maxFeePerGas: Hex;
    maxPriorityFeePerGas: Hex;
    nonce: number;
  };
  sendRequest: { method: "eth_sendTransaction"; params: [Record<string, string>] };
  byAuthorization?: Authorization;
}

export interface Built {
  plan?: Plan;
  verdicts: Verdict[];
  name?: NameCheck;
  facts?: AccountFacts;
  outcome?: Outcome;
  intent: Intent;
}

export interface BuildOptions {
  resolver?: Resolver;
  /** unix seconds; tests pin it */
  now?: number;
}

const ERC20 = parseAbi(["function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)", "function symbol() view returns (string)"]);

/** EIP-55: an all-lowercase address is accepted as typed; a mixed-case one has to carry a valid checksum. */
function checkAddress(a: string, what: string): { address?: Hex; verdict: Verdict } {
  if (!isAddress(a, { strict: false })) return { verdict: { level: "BLOCK", says: `${what} "${a}" is not an address.` } };
  const mixed = /[a-f]/.test(a.slice(2)) && /[A-F]/.test(a.slice(2));
  if (mixed && !isAddress(a, { strict: true }))
    return { verdict: { level: "BLOCK", says: `${what} ${a} has mixed-case letters that fail the EIP-55 checksum. That usually means a typo; paste it again from the source.` } };
  return { address: getAddress(a), verdict: { level: "PASS", says: `${what} ${getAddress(a)} is a valid address${mixed ? " (checksum ok)" : " (typed in lowercase, so there was no checksum to check)"}.` } };
}

async function readToken(ph: Chain, typed: string): Promise<{ token?: Token; verdicts: Verdict[] }> {
  const listed = typed.startsWith("0x") ? REGISTRY.find((t) => t.address !== "native" && t.address.toLowerCase() === typed.toLowerCase()) : findBySymbol(typed);
  if (!listed && !typed.startsWith("0x")) {
    return { verdicts: [{ level: "BLOCK", says: `${typed} is not on the Pharos mainnet token list (PROS, WPROS, USDC, LINK, WETH). A symbol alone can be anyone's token, so give me its contract address.` }] };
  }
  if (listed?.address === "native") return { token: listed, verdicts: [{ level: "PASS", says: "PROS is the native coin: no contract involved." }] };

  const at = (listed?.address ?? typed) as Hex;
  if (!isAddress(at)) return { verdicts: [{ level: "BLOCK", says: `${typed} is not a valid contract address.` }] };
  const code = await ph.code(at);
  if (code === "0x") return { verdicts: [{ level: "BLOCK", says: `there is no contract at ${at} on Pharos.` }] };
  const [d, s] = await Promise.all([ph.call({ to: at, data: encodeFunctionData({ abi: ERC20, functionName: "decimals" }) }), ph.call({ to: at, data: encodeFunctionData({ abi: ERC20, functionName: "symbol" }) })]);
  if (!d.ok || d.data === "0x") return { verdicts: [{ level: "BLOCK", says: `${short(at)} doesn't answer decimals(), so it isn't a token I can prepare a transfer for.` }] };
  const decimals = Number(BigInt(d.data));
  let symbol = "?";
  try {
    if (s.ok) symbol = decodeAbiParameters([{ type: "string" }], s.data)[0];
  } catch {
    /* some tokens return bytes32; the address is what matters anyway */
  }
  if (listed) {
    if (decimals !== listed.decimals) return { verdicts: [{ level: "BLOCK", says: `${listed.symbol} at ${short(at)} reports ${decimals} decimals on chain, but the docs list ${listed.decimals}. Not guessing which is right.` }] };
    return { token: listed, verdicts: [{ level: "PASS", says: `${listed.symbol} is the contract ${getAddress(at)} from the Pharos docs token list; decimals() = ${decimals} read on chain.` }] };
  }
  const token: Token = { symbol, address: getAddress(at), decimals, source: "read from chain" };
  const clash = findBySymbol(symbol);
  return {
    token,
    verdicts: [
      clash
        ? { level: "BLOCK", says: `${short(at)} calls itself ${symbol}, but the real ${symbol} on Pharos is ${clash.address}. This one is a look-alike.` }
        : { level: "WARN", says: `${short(at)} calls itself "${symbol}" (${decimals} decimals). It's not on the docs list; anyone can deploy a token with any name, so check the contract with whoever you're paying.` },
    ],
  };
}

const fmt = (raw: bigint, decimals: number) => formatUnits(raw, decimals);

export async function buildPlan(ph: Chain, l1: Chain, intent: Intent, fromTyped: string, opts: BuildOptions = {}): Promise<Built> {
  const verdicts: Verdict[] = [];
  const done = (extra: Partial<Built> = {}): Built => ({ verdicts, intent, ...extra });
  const blocked = () => verdicts.some((v) => v.level === "BLOCK");

  const sender = checkAddress(fromTyped, "your address");
  if (!sender.address) return verdicts.push(sender.verdict), done();
  const from = sender.address;

  // Who gets it
  let to: Hex | undefined;
  let name: NameCheck | undefined;
  if (intent.recipientKind === "self") {
    to = from;
  } else if (intent.recipientKind === "name") {
    name = await resolveName(intent.recipient, l1, ph, opts.resolver);
    verdicts.push(name.verdict);
    to = name.address;
  } else {
    const r = checkAddress(intent.recipient, "recipient");
    verdicts.push(r.verdict);
    to = r.address;
  }

  // What gets sent
  const t = await readToken(ph, intent.token);
  verdicts.push(...t.verdicts);
  if (blocked() || !to || !t.token) return done({ name });
  const token = t.token;

  const places = (intent.amount.split(".")[1] ?? "").length;
  if (places > token.decimals) {
    verdicts.push({ level: "BLOCK", says: `${intent.amount} has ${places} decimals, but ${token.symbol} only has ${token.decimals}. Not rounding it for you; say the amount you mean.` });
    return done({ name });
  }
  const raw = parseUnits(intent.amount, token.decimals);
  if (raw === 0n) {
    verdicts.push({ level: "BLOCK", says: "the amount is zero." });
    return done({ name });
  }

  // Can you pay it
  const pros = await ph.nativeBalance(from);
  let held = pros;
  if (token.address !== "native") {
    const b = await ph.call({ to: token.address, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [from] }) });
    held = b.ok && b.data !== "0x" ? BigInt(b.data) : 0n;
  }
  if (held < raw) {
    verdicts.push({ level: "BLOCK", says: `you hold ${fmt(held, token.decimals)} ${token.symbol} and this needs ${intent.amount}.` });
    return done({ name });
  }
  verdicts.push({ level: "PASS", says: `you hold ${fmt(held, token.decimals)} ${token.symbol}, this needs ${intent.amount}.` });

  // Who lives there and what the money does
  const facts = await accountFacts(ph, to);
  const out = await outcome(ph, { from, to, token, raw });
  verdicts.push(...recipientVerdicts(facts, out, from, token));
  if (blocked() || !out.gas) return done({ name, facts, outcome: out });

  // Fees. Pharos runs a flat 10 gwei base fee and reports 0 for the priority fee (checked 2026-11-07); a 2x
  // ceiling and a 20% gas margin keep the tx valid if either moves before you sign.
  const gas = (out.gas * 12n + 9n) / 10n;
  const price = await ph.gasPrice();
  const maxFee = price * 2n;
  const fee = gas * maxFee;
  const needPros = fee + (token.address === "native" ? raw : 0n);
  if (pros < needPros) {
    verdicts.push({
      level: "BLOCK",
      says: `you hold ${fmt(pros, 18)} PROS and this needs up to ${fmt(needPros, 18)} PROS${token.address === "native" ? ` (${intent.amount} plus a fee of up to ${fmt(fee, 18)})` : ` for the fee`}.`,
    });
    return done({ name, facts, outcome: out });
  }

  const sim = transferTx({ from, to, token, raw });
  const nonce = await ph.nonce(from);
  const tx: Plan["tx"] = {
    chainId: PHAROS_CHAIN_ID,
    type: "0x2",
    from,
    to: getAddress(sim.to),
    data: sim.data,
    value: toHex(sim.value),
    gas: toHex(gas),
    maxFeePerGas: toHex(maxFee),
    maxPriorityFeePerGas: "0x0",
    nonce,
  };
  // Paying yourself moves nothing out, so only the gas leaves (and only PROS pays gas).
  const leaves = to === from ? 0n : raw;
  const after = token.address === "native" ? pros - leaves - out.gas * price : held - leaves;
  const plan: Plan = {
    createdAt: new Date((opts.now ?? Math.floor(Date.now() / 1000)) * 1000).toISOString(),
    block: out.block,
    intent,
    from,
    to,
    name: name?.name,
    token,
    amount: intent.amount,
    raw: raw.toString(),
    verdicts,
    recipient: to === from ? "you" : describe(facts),
    maxFeePros: fmt(fee, 18),
    balanceAfter: `${fmt(after, token.decimals)} ${token.symbol}`,
    tx,
    sendRequest: { method: "eth_sendTransaction", params: [{ from, to: tx.to, data: tx.data, value: tx.value, gas: tx.gas }] },
  };
  if (token.address === USDC.address) plan.byAuthorization = authorization(from, to, raw, opts.now);
  return done({ plan, name, facts, outcome: out });
}

/**
 * EIP-3009 ReceiveWithAuthorization on Pharos USDC (domain "USDC" / "2" / 1672, checked on chain). You sign a
 * message instead of a transaction; only the payee can turn it into a transfer, because the contract requires
 * msg.sender == to. So a leaked signature can't be redirected, and the payer needs no PROS at all.
 */
function authorization(from: Hex, to: Hex, raw: bigint, now = Math.floor(Date.now() / 1000)): Authorization {
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const validBefore = now + AUTH_WINDOW_SECONDS;
  return {
    payee: to,
    nonce,
    validBefore,
    typedData: {
      domain: { name: "USDC", version: "2", chainId: PHAROS_CHAIN_ID, verifyingContract: USDC.address },
      types: {
        EIP712Domain: [
          { name: "name", type: "string" },
          { name: "version", type: "string" },
          { name: "chainId", type: "uint256" },
          { name: "verifyingContract", type: "address" },
        ],
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      },
      primaryType: "ReceiveWithAuthorization",
      message: { from, to, value: raw.toString(), validAfter: "0", validBefore: String(validBefore), nonce },
    },
  };
}

/** The payee's half: signature in, receiveWithAuthorization calldata out. */
export function receiveCalldata(auth: Authorization, signature: Hex): Hex {
  const m = (auth.typedData as { message: Record<string, string> }).message;
  const { r, s, v, yParity } = parseSignature(signature);
  return encodeFunctionData({
    abi: RECEIVE_ABI,
    functionName: "receiveWithAuthorization",
    args: [m.from as Hex, m.to as Hex, BigInt(m.value), BigInt(m.validAfter), BigInt(m.validBefore), m.nonce as Hex, Number(v ?? BigInt(27 + yParity)), r, s],
  });
}
