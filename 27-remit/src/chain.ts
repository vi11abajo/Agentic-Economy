// The chain check. The paper check (validator.ts) only knows what the invoice says; this asks Pharos whether the
// payment it describes would actually work and whether it already happened. All reads, no keys.
import { createPublicClient, formatEther, formatGwei, formatUnits, http, parseAbi, type Hex, type PublicClient } from "viem";
import type { ChainCheck, UnsignedTransaction, ValidatedInvoice, ValidationFlag } from "./types.js";
import { PHAROS_RPC, addressLink, txLink } from "./tokens.js";

const ERC20 = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
]);
const HISTORY = "https://api.socialscan.io/pharos-mainnet/v1/explorer/address";

export function pharos(rpc = PHAROS_RPC): PublicClient {
  return createPublicClient({ transport: http(rpc, { timeout: 20_000, retryCount: 2 }) });
}

const firstLine = (e: unknown) => String((e as { shortMessage?: string }).shortMessage ?? (e as Error).message ?? e).split("\n")[0];

type Seen = { hash: Hex; to: string };

/**
 * Recent payments that landed on the payee, from the explorer index pharosscan runs on (the chain itself has no
 * "transactions by address" call). We only use it to find candidates; the verdict comes from the tx input on chain.
 */
async function recentPaymentsTo(payee: Hex, invoice: ValidatedInvoice): Promise<Seen[] | undefined> {
  const path = invoice.token.isNative ? "transactions" : "token_transfers";
  try {
    const r = await fetch(`${HISTORY}/${payee}/${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { data?: Record<string, string>[] };
    const me = payee.toLowerCase();
    return (body.data ?? [])
      .filter((row) => row.to_address?.toLowerCase() === me)
      .filter((row) => invoice.token.isNative || row.token_address?.toLowerCase() === invoice.token.address?.toLowerCase())
      .map((row) => ({ hash: (row.hash ?? row.transaction_hash) as Hex, to: row.to_address }));
  } catch {
    return undefined;
  }
}

export interface ChainVerdict {
  flags: ValidationFlag[];
  chain: ChainCheck;
  gasLimit?: Hex;
}

export async function checkOnChain(client: PublicClient, invoice: ValidatedInvoice, tx: UnsignedTransaction, from?: Hex): Promise<ChainVerdict> {
  const flags: ValidationFlag[] = [];
  const say = (severity: ValidationFlag["severity"], code: ValidationFlag["code"], message: string, proof?: string) =>
    flags.push({ code, severity, message, ...(proof ? { proof } : {}) });

  let block: bigint;
  try {
    block = await client.getBlockNumber();
  } catch (e) {
    say("FATAL", "CHAIN_UNREACHABLE", `Couldn't reach Pharos (${firstLine(e)}). Nothing was checked on chain, so no plan.`);
    return { flags, chain: { block: "?", checkedAt: new Date().toISOString() } };
  }
  const chain: ChainCheck = { block: block.toString(), checkedAt: new Date().toISOString(), ...(from ? { from } : {}) };
  const token = invoice.token;

  // 1. The token we're about to call really is that token.
  if (!token.isNative && token.address) {
    const code = await client.getCode({ address: token.address });
    if (!code || code === "0x") {
      say("FATAL", "TOKEN_NOT_ON_CHAIN", `${token.symbol} at ${token.address} has no contract code on Pharos. A transfer() there would "succeed" and move nothing.`, addressLink(token.address));
    } else {
      const [symbol, decimals] = await Promise.all([
        client.readContract({ address: token.address, abi: ERC20, functionName: "symbol" }).catch(() => undefined),
        client.readContract({ address: token.address, abi: ERC20, functionName: "decimals" }).catch(() => undefined),
      ]);
      if (symbol !== token.symbol || decimals !== token.decimals)
        say("FATAL", "TOKEN_NOT_ON_CHAIN", `The contract at ${token.address} says it is ${symbol ?? "?"} with ${decimals ?? "?"} decimals, not ${token.symbol}/${token.decimals}.`, addressLink(token.address));
    }
  }

  // 2. Paying a contract is fine (a multisig, a merchant vault), but worth a second look.
  const payeeCode = await client.getCode({ address: invoice.payee });
  if (payeeCode && payeeCode !== "0x")
    say("WARNING", "PAYEE_IS_CONTRACT", `The payee ${invoice.payee} is a contract, not a plain wallet. Fine for a multisig or a merchant vault; make sure that's what the issuer meant.`, addressLink(invoice.payee));

  // 3. Was this exact invoice paid already? Same payee, same token, and the reference in the tx input.
  const memoHex = Buffer.from(`INV:${invoice.reference}`, "utf8").toString("hex");
  const seen = await recentPaymentsTo(invoice.payee, invoice);
  if (!seen) {
    say("INFO", "CHAIN_UNREACHABLE", "Couldn't read the payee's recent history from the explorer, so a repeat payment wasn't ruled out.");
  } else {
    for (const s of seen.slice(0, 25)) {
      const got = await client.getTransaction({ hash: s.hash }).catch(() => undefined);
      if (!got || !got.input.toLowerCase().includes(memoHex)) continue;
      const receipt = await client.getTransactionReceipt({ hash: s.hash }).catch(() => undefined);
      if (receipt?.status !== "success") continue;
      say("FATAL", "ALREADY_PAID", `This invoice (${invoice.reference}) was already paid to ${invoice.payee} in block ${got.blockNumber}, from ${got.from}.`, txLink(s.hash));
      break;
    }
  }

  // 4. With a payer: can they cover it, and does the exact tx go through right now?
  let gasLimit: Hex | undefined;
  if (from) {
    const native = await client.getBalance({ address: from });
    const holds = token.isNative ? native : await client.readContract({ address: token.address!, abi: ERC20, functionName: "balanceOf", args: [from] });
    chain.payerHolds = formatUnits(holds, token.decimals);
    if (holds < invoice.amountRaw)
      say("FATAL", "NOT_ENOUGH_FUNDS", `${from} holds ${formatUnits(holds, token.decimals)} ${token.symbol}; the invoice needs ${invoice.amount}.`, addressLink(from));

    try {
      const [gas, price] = await Promise.all([
        client.estimateGas({ account: from, to: tx.to, value: BigInt(tx.value), data: tx.data }),
        client.getGasPrice(),
      ]);
      const padded = (gas * 12n) / 10n; // 20% headroom, the wallet may still pick its own
      gasLimit = `0x${padded.toString(16)}`;
      chain.gasEstimate = gas.toString();
      chain.gasPriceGwei = formatGwei(price);
      chain.feePros = formatEther(padded * price);
      const needsNative = padded * price + (token.isNative ? invoice.amountRaw : 0n);
      if (native < needsNative)
        say("FATAL", "NOT_ENOUGH_FUNDS", `${from} has ${formatEther(native)} PROS; this needs about ${formatEther(needsNative)} PROS including gas.`, addressLink(from));
    } catch (e) {
      if (!flags.some((f) => f.code === "NOT_ENOUGH_FUNDS"))
        say("FATAL", "WOULD_REVERT", `Pharos refused the dry run of this exact transaction from ${from}: ${firstLine(e)}`);
    }
  }

  return { flags, chain, gasLimit };
}

/** After the fact: does a mined tx pay exactly what the plan asked for? */
export async function checkPaid(client: PublicClient, hash: Hex, tx: UnsignedTransaction): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  const got = await client.getTransaction({ hash }).catch(() => undefined);
  if (!got) return { ok: false, lines: [`${hash} isn't on Pharos (yet?).`] };
  const receipt = await client.getTransactionReceipt({ hash }).catch(() => undefined);
  const sameTo = got.to?.toLowerCase() === tx.to.toLowerCase();
  const sameValue = got.value === BigInt(tx.value);
  const sameInput = got.input.toLowerCase() === tx.data.toLowerCase();
  lines.push(`block ${got.blockNumber} · from ${got.from} · status ${receipt?.status ?? "pending"}`);
  lines.push(`to ${sameTo ? "matches" : `DIFFERS (${got.to})`} · value ${sameValue ? "matches" : `DIFFERS (${got.value})`} · input ${sameInput ? "matches byte for byte, reference included" : "DIFFERS"}`);
  lines.push(txLink(hash));
  return { ok: receipt?.status === "success" && sameTo && sameValue && sameInput, lines };
}
