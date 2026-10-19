// --verify: pulls checkable facts out of a docs answer and checks them on Pharos Pacific Mainnet through
// Pharos Chain MCP. The docs can be wrong (see task 03), the chain can't.
import { decodeFunctionResult, encodeFunctionData, parseAbi, type Hex } from "viem";

export const MAINNET_CHAIN_ID = 1672;
const PROBE_ADDRESS = "0xc879c018db60520f4355c26ed1a6d572cdac1815"; // USDC, keeps get_logs probes small

/** The part of the Pharos MCP client the checks need (PharosMcp implements it). */
export interface ChainSource {
  call<T>(tool: string, args?: Record<string, unknown>): Promise<T>;
}

export interface Claims {
  addresses: string[];
  chainIds: number[];
  blockLimits: number[];
}

export interface Check {
  claim: string;
  status: "ok" | "wrong" | "note";
  detail: string;
}

export function extractClaims(text: string): Claims {
  const addresses = unique([...text.matchAll(/\b0x[a-fA-F0-9]{40}\b/g)].map((m) => m[0].toLowerCase())).slice(0, 6);
  const chainIds = unique([...text.matchAll(/chain\s*ID\D{0,15}?(\d{3,7})\b/gi)].map((m) => Number(m[1])));
  const blockLimits: number[] = [];
  for (const sentence of text.split(/(?<=[.!?\n])\s+/)) {
    if (!/get_?logs|getlogs|block range|per (?:call|request|query)|\bcap(?:ped)?\b|\blimit|max(?:imum)?/i.test(sentence)) continue;
    for (const m of sentence.matchAll(/\b(\d{1,3}(?:,\d{3})+|\d{2,6})\s*blocks?\b/gi)) {
      const n = Number(m[1].replace(/,/g, ""));
      if (n >= 10 && n <= 100_000) blockLimits.push(n);
    }
  }
  return { addresses, chainIds, blockLimits: unique(blockLimits).slice(0, 4) };
}

export function hasClaims(c: Claims): boolean {
  return c.addresses.length + c.chainIds.length + c.blockLimits.length > 0;
}

const erc20 = parseAbi(["function symbol() view returns (string)", "function name() view returns (string)"]);

export async function verifyClaims(chain: ChainSource, claims: Claims): Promise<{ block: number; checks: Check[] }> {
  const info = await chain.call<{ chainId: number; latestBlock: string }>("get_chain_info");
  const block = Number(info.latestBlock) - 3;
  const checks: Check[] = [];

  for (const id of claims.chainIds) {
    checks.push(id === info.chainId
      ? { claim: `chain ID ${id}`, status: "ok", detail: "matches Pacific Mainnet" }
      : { claim: `chain ID ${id}`, status: "note", detail: `not mainnet (${info.chainId}), probably the Atlantic testnet; Pharos MCP only sees mainnet` });
  }

  for (const address of claims.addresses) {
    const { code } = await chain.call<{ code: Hex }>("get_code", { address, block: hex(block) });
    if (!code || code === "0x") {
      checks.push({ claim: short(address), status: "note", detail: "no contract on mainnet (could be a testnet address or a wallet)" });
      continue;
    }
    const symbol = await read(chain, address, "symbol", block);
    const name = symbol ? undefined : await read(chain, address, "name", block);
    checks.push({
      claim: short(address),
      status: "ok",
      detail: `contract on mainnet${symbol ? `, symbol() = ${symbol}` : name ? `, name() = ${name}` : ""}`,
    });
  }

  let realLimit: number | undefined;
  for (const n of claims.blockLimits) {
    const okN = await logsAccepted(chain, block, n);
    const okN1 = await logsAccepted(chain, block, n + 1);
    const claim = `${n.toLocaleString("en-US")} blocks per get_logs call`;
    if (okN && !okN1) {
      checks.push({ claim, status: "ok", detail: `${n} blocks accepted, ${n + 1} rejected` });
      continue;
    }
    realLimit ??= await findLimit(chain, block, okN ? n + 1 : 1, okN ? undefined : n);
    checks.push({ claim, status: "wrong", detail: `the real limit is ${realLimit.toLocaleString("en-US")} blocks (${(realLimit + 1).toLocaleString("en-US")} get rejected)` });
  }
  return { block, checks };
}

/** Largest accepted range: grows from `lo` (accepted) until a rejection, then bisects. */
async function findLimit(chain: ChainSource, head: number, lo: number, hi?: number): Promise<number> {
  let ok = lo;
  let bad = hi;
  while (bad === undefined) {
    const probe = ok * 2 < 1000 ? 1000 : ok * 2;
    if (await logsAccepted(chain, head, probe)) ok = probe;
    else bad = probe;
    if (ok > 100_000) return ok;
  }
  while (bad - ok > 1) {
    const mid = Math.floor((ok + bad) / 2);
    if (await logsAccepted(chain, head, mid)) ok = mid;
    else bad = mid;
  }
  return ok;
}

async function logsAccepted(chain: ChainSource, head: number, blocks: number): Promise<boolean> {
  try {
    await chain.call("get_logs", { address: PROBE_ADDRESS, fromBlock: hex(head - blocks + 1), toBlock: hex(head) });
    return true;
  } catch (err) {
    if (/block range|too large|within [\d,]+ blocks|max(imum)? .*blocks/i.test(String((err as Error).message ?? err))) return false;
    throw err;
  }
}

async function read(chain: ChainSource, to: string, fn: "symbol" | "name", block: number): Promise<string | undefined> {
  try {
    const { result } = await chain.call<{ result: Hex }>("eth_call", {
      transaction: { to, data: encodeFunctionData({ abi: erc20, functionName: fn }) },
      block: hex(block),
    });
    if (!result || result === "0x") return undefined;
    return decodeFunctionResult({ abi: erc20, functionName: fn, data: result }) as string;
  } catch {
    return undefined; // not an ERC-20
  }
}

const hex = (n: number) => `0x${n.toString(16)}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function unique<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
