import {
  decodeAbiParameters,
  decodeFunctionResult,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  keccak256,
  pad,
  parseAbi,
  parseAbiItem,
  parseUnits,
  toBytes,
  toFunctionSelector,
  toHex,
  type AbiFunction,
} from "viem";
import { blockWithTxs, gasFor, newestLog, shoot, txByHash, type RawLog, type RawTx, type Shot } from "./chain.js";
import type { Brief, LookupPlan, Quote } from "./docs.js";
import { cctpFacts, x402Facts, type HeaderField } from "./facts.js";
import type { ToolLine } from "./mcp.js";

export type Mark = "MATCH" | "DIFFERENT" | "DOCS SILENT" | "CHAIN SAYS NO" | "NOTE";

/** One line of the final reading: what the docs promised, what the chain answered, and whether they agree. */
export interface Verdict {
  mark: Mark;
  topic: string;
  docs?: Quote;
  docsValue?: string;
  chainValue?: string;
}

/** Everything the chain step did, saved so `read` can work from exactly that and nothing newer. */
export interface Sheet {
  key: string;
  subject: string;
  madeAt: number;
  block: number;
  shots: Shot[];
  gas?: { gas?: number; reason?: string };
  log?: RawLog;
  notes: Record<string, string>;
}

export interface Reading {
  key: string;
  subject: string;
  verdicts: Verdict[];
  /** Plain sentences that put the numbers in the docs' terms. Built from the values, never canned. */
  plainly: string[];
}

export interface Target {
  key: string;
  subject: string;
  plan(): LookupPlan;
  fire(chain: ToolLine, brief: Brief, head: number): Promise<Sheet>;
  judge(brief: Brief, sheet: Sheet): Reading;
}

export class NothingToCall extends Error {}

function sheetOf(t: { key: string; subject: string }, block: number, shots: Shot[], notes: Record<string, string> = {}): Sheet {
  return { key: t.key, subject: t.subject, madeAt: Date.now(), block, shots, notes };
}

function same(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();
}

function compare(topic: string, docs: { value: string; quote: Quote } | undefined, chainValue: string | undefined): Verdict {
  if (!docs) return { mark: "DOCS SILENT", topic, chainValue };
  if (chainValue === undefined) return { mark: "CHAIN SAYS NO", topic, docs: docs.quote, docsValue: docs.value };
  return { mark: same(docs.value, chainValue) ? "MATCH" : "DIFFERENT", topic, docs: docs.quote, docsValue: docs.value, chainValue };
}

// ------------------------------------------------------------------ x402: the token's EIP-712 domain

const TOKEN_READS = parseAbi([
  "function name() view returns (string)",
  "function version() view returns (string)",
  "function decimals() view returns (uint8)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
]);

function readString(shot: Shot | undefined, fn: "name" | "version"): string | undefined {
  if (!shot?.ok || !shot.result) return undefined;
  return decodeFunctionResult({ abi: TOKEN_READS, functionName: fn, data: shot.result as `0x${string}` });
}

const X402_SEARCHES = ["x402 Pacific Mainnet USDC token address", "x402 EIP-712 USDC name version"];
const X402_NEEDLES = ["USDC token address", "USDC_NAME", "version:", "eip155:", "decimals precision", "price:", "e.g.,"];

/** The EIP-712 domain hash every x402 "exact" payment signature is checked against. */
export function domainSeparator(name: string, version: string, chainId: bigint, token: string): string {
  const typeHash = keccak256(toBytes("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"));
  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }],
      [typeHash, keccak256(toBytes(name)), keccak256(toBytes(version)), chainId, getAddress(token)],
    ),
  );
}

export function x402Domain(): Target {
  const me = { key: "x402-domain", subject: "DOMAIN_SEPARATOR() of the USDC token x402 payments use on Pharos" };
  return {
    ...me,
    plan: () => ({ ...me, searches: X402_SEARCHES, needles: X402_NEEDLES }),
    async fire(chain, brief, head) {
      const token = x402Facts(brief.pages).token?.value;
      if (!token) throw new NothingToCall("the docs brief gives no USDC token address, so there is no contract to call");
      const shots: Shot[] = [];
      for (const fn of ["name", "version", "DOMAIN_SEPARATOR"] as const) {
        shots.push(await shoot(chain, `${fn}()`, { to: token, data: encodeFunctionData({ abi: TOKEN_READS, functionName: fn }) }, head));
      }
      return sheetOf(me, head, shots);
    },
    judge(brief, sheet) {
      const f = x402Facts(brief.pages);
      const [nameShot, versionShot, sepShot] = sheet.shots;
      const chainName = readString(nameShot, "name");
      const chainVersion = readString(versionShot, "version");
      const verdicts: Verdict[] = [
        compare("EIP-712 name the docs sign with vs token name()", f.tokenName, chainName),
        compare("EIP-712 version the docs sign with vs token version()", f.version, chainVersion),
      ];
      const plainly: string[] = [];
      const chainSep = sepShot?.ok ? sepShot.result : undefined;
      if (f.tokenName && f.version && f.chainId && f.token) {
        const expected = domainSeparator(f.tokenName.value, f.version.value, BigInt(f.chainId.value), f.token.value);
        const v: Verdict = {
          mark: chainSep === undefined ? "CHAIN SAYS NO" : same(expected, chainSep) ? "MATCH" : "DIFFERENT",
          topic: `DOMAIN_SEPARATOR built from the docs (name "${f.tokenName.value}", version "${f.version.value}", chain ${f.chainId.value}, token ${f.token.value}) vs DOMAIN_SEPARATOR()`,
          docs: f.chainId.quote,
          docsValue: expected,
          chainValue: chainSep,
        };
        verdicts.push(v);
        if (v.mark === "MATCH") {
          plainly.push(
            `A payment signed with exactly the settings in the docs lands in the same EIP-712 domain this token checks signatures in, so it will verify (domain ${expected}).`,
          );
        } else if (v.mark === "DIFFERENT") {
          plainly.push(`A payment signed with the docs' settings would be checked in domain ${expected}, but the token uses ${chainSep}: such signatures would be rejected.`);
        }
      } else {
        verdicts.push({ mark: "DOCS SILENT", topic: "the docs do not give all four EIP-712 values, so the expected separator cannot be rebuilt", chainValue: chainSep });
      }
      return { key: sheet.key, subject: sheet.subject, verdicts, plainly };
    },
  };
}

// ------------------------------------------------------------------ x402: what a price turns into

export function x402Decimals(): Target {
  const me = { key: "x402-decimals", subject: "decimals() of the USDC token x402 payments use on Pharos" };
  return {
    ...me,
    plan: () => ({ ...me, searches: X402_SEARCHES, needles: X402_NEEDLES }),
    async fire(chain, brief, head) {
      const token = x402Facts(brief.pages).token?.value;
      if (!token) throw new NothingToCall("the docs brief gives no USDC token address, so there is no contract to call");
      const shot = await shoot(chain, "decimals()", { to: token, data: encodeFunctionData({ abi: TOKEN_READS, functionName: "decimals" }) }, head);
      return sheetOf(me, head, [shot]);
    },
    judge(brief, sheet) {
      const f = x402Facts(brief.pages);
      const shot = sheet.shots[0];
      const chainDecimals = shot?.ok && shot.result
        ? String(decodeFunctionResult({ abi: TOKEN_READS, functionName: "decimals", data: shot.result as `0x${string}` }))
        : undefined;
      const verdicts: Verdict[] = [compare("decimals the docs scale prices with vs token decimals()", f.decimals, chainDecimals)];
      const plainly: string[] = [];
      if (chainDecimals !== undefined && f.example && f.exampleUnits) {
        const units = parseUnits(f.example.value, Number(chainDecimals)).toString();
        verdicts.push({
          mark: units === f.exampleUnits ? "MATCH" : "DIFFERENT",
          topic: `the docs' worked example ${f.example.value} -> "${f.exampleUnits}" redone with the chain's ${chainDecimals} decimals`,
          docs: f.example.quote,
          docsValue: f.exampleUnits,
          chainValue: units,
        });
      }
      if (chainDecimals !== undefined) {
        for (const price of f.prices) {
          const units = parseUnits(price.value, Number(chainDecimals));
          verdicts.push({ mark: "NOTE", topic: `price "${price.value}" in the docs' server example`, docs: price.quote, docsValue: price.value, chainValue: `${units} base units` });
          plainly.push(`A ${price.value} USD x402 call moves ${units} base units of USDC (${price.value} x 10^${chainDecimals}).`);
        }
      }
      return { key: sheet.key, subject: sheet.subject, verdicts, plainly };
    },
  };
}

// ------------------------------------------------------------------ CCTP: sendMessage, simulated only

const CCTP_ABI = parseAbi([
  "function localDomain() view returns (uint32)",
  "function version() view returns (uint32)",
  "function sendMessage(uint32 destinationDomain, bytes32 recipient, bytes32 destinationCaller, uint32 minFinalityThreshold, bytes messageBody)",
]);

export const MESSAGE_SENT_TOPIC = keccak256(toBytes("MessageSent(bytes)"));

export interface SendOptions {
  destinationDomain: number;
  recipient: string;
  from: string;
  destinationCaller?: string;
  minFinality?: number;
  body: string;
}

function asBytes32(address: string): `0x${string}` {
  return pad(getAddress(address), { size: 32 });
}

/** Cuts a CCTP message into the header fields the docs table lists, by the offsets the docs give. */
export function cutMessage(message: string, header: HeaderField[]): { field: HeaderField; hex: string }[] {
  const bytes = message.startsWith("0x") ? message.slice(2) : message;
  return header.map((field) => {
    const start = field.offset * 2;
    const end = field.length === undefined ? bytes.length : start + field.length * 2;
    return { field, hex: `0x${bytes.slice(start, end)}` };
  });
}

function asNumber(hex: string): string {
  return hex === "0x" ? "" : BigInt(hex).toString();
}

function asAddress(word: string): string {
  return getAddress(`0x${word.slice(-40)}`);
}

export function cctpSend(opts: SendOptions): Target {
  const me = { key: "cctp-send", subject: "MessageTransmitterV2.sendMessage on Pharos (Circle CCTP), simulated" };
  return {
    ...me,
    plan: () => ({
      ...me,
      searches: ["MessageTransmitterV2 sendMessage", "CCTP message header format finality threshold"],
      needles: ["sendMessage", "MessageTransmitterV2", "finalityThresholdExecuted", "**Pharos**", "nonces offchain", "use 1 for CCTP"],
      maxPages: 2,
    }),
    async fire(chain, brief, head) {
      const f = cctpFacts(brief.pages);
      const to = f.transmitter?.value;
      if (!to) throw new NothingToCall("the docs brief gives no MessageTransmitterV2 address on Pharos, so there is no contract to call");
      const minFinality = opts.minFinality ?? Number(f.finalizedAt?.value ?? 2000);
      const data = encodeFunctionData({
        abi: CCTP_ABI,
        functionName: "sendMessage",
        args: [
          opts.destinationDomain,
          asBytes32(opts.recipient),
          opts.destinationCaller ? asBytes32(opts.destinationCaller) : pad("0x", { size: 32 }),
          minFinality,
          toHex(toBytes(opts.body)),
        ],
      });
      const shots = [
        await shoot(chain, "localDomain()", { to, data: encodeFunctionData({ abi: CCTP_ABI, functionName: "localDomain" }) }, head),
        await shoot(chain, "version()", { to, data: encodeFunctionData({ abi: CCTP_ABI, functionName: "version" }) }, head),
        await shoot(chain, "sendMessage(...)", { to, data, from: opts.from }, head),
      ];
      const sheet = sheetOf(me, head, shots, {
        destinationDomain: String(opts.destinationDomain),
        recipient: getAddress(opts.recipient),
        from: getAddress(opts.from),
        minFinality: String(minFinality),
        body: opts.body,
      });
      sheet.gas = await gasFor(chain, { to, data, from: opts.from });
      sheet.log = await newestLog(chain, to, MESSAGE_SENT_TOPIC, head);
      return sheet;
    },
    judge(brief, sheet) {
      const f = cctpFacts(brief.pages);
      const [domainShot, versionShot, sendShot] = sheet.shots;
      const num = (s: Shot | undefined) => (s?.ok && s.result ? asNumber(s.result) : undefined);
      const verdicts: Verdict[] = [
        compare("Pharos domain in the docs table vs localDomain()", f.localDomain, num(domainShot)),
        compare("message version the docs say to use vs version()", f.version, num(versionShot)),
      ];
      const plainly: string[] = [];
      const dest = sheet.notes.destinationDomain ?? "";
      if (f.localDomain && dest === f.localDomain.value) {
        verdicts.push({ mark: "NOTE", topic: `destination ${dest} is Pharos itself (the docs' own domain)`, docs: f.localDomain.quote, docsValue: f.localDomain.value, chainValue: dest });
      } else {
        verdicts.push({ mark: "DOCS SILENT", topic: `destination domain ${dest}: the Pharos page lists only Pharos' own domain and links Circle's list for the rest`, chainValue: dest });
      }
      const finalized = f.finalizedAt ? Number(sheet.notes.minFinality) >= Number(f.finalizedAt.value) : undefined;
      if (f.finalizedAt) {
        verdicts.push({
          mark: "NOTE",
          topic: `minFinalityThreshold ${sheet.notes.minFinality}: ${finalized ? "finalized" : "unfinalized"} by the docs' line`,
          docs: f.finalizedAt.quote,
          docsValue: f.finalizedAt.value,
          chainValue: sheet.notes.minFinality,
        });
      }
      if (sendShot?.ok) {
        verdicts.push({ mark: "NOTE", topic: "sendMessage simulated with eth_call from the caller: it goes through", chainValue: sheet.gas?.gas !== undefined ? `estimate ${sheet.gas.gas} gas` : "no gas estimate" });
        plainly.push(
          `Sent for real, this call would put a message from ${sheet.notes.from} to domain ${dest} on chain` +
            (sheet.gas?.gas !== undefined ? ` for about ${sheet.gas.gas} gas` : "") +
            `, and the recipient would get it through ${finalized ? "handleReceiveFinalizedMessage" : "handleReceiveUnfinalizedMessage"} on the other side. Nothing was sent: this was eth_call only.`,
        );
      } else {
        verdicts.push({ mark: "CHAIN SAYS NO", topic: "sendMessage simulated with eth_call from the caller", chainValue: sendShot?.reason ?? "reverted without a reason" });
        plainly.push(`The contract refuses this exact call${sendShot?.reason ? `: "${sendShot.reason}"` : ""}. Sent for real it would revert and only burn gas.`);
      }

      if (sheet.log && f.header.length > 0) {
        const [message] = decodeAbiParameters([{ type: "bytes" }], sheet.log.data as `0x${string}`);
        const pieces = cutMessage(message, f.header);
        const get = (name: string) => pieces.find((p) => p.field.name === name)?.hex;
        plainly.push(`For comparison, the newest real MessageSent on this contract (block ${Number(sheet.log.blockNumber)}, tx ${sheet.log.transactionHash}) cut by the docs table:`);
        for (const { field, hex } of pieces) {
          const shown = field.length === 4 ? asNumber(hex) : field.type === "bytes32" && /sender|recipient|caller/i.test(field.name) ? asAddress(hex) : field.length === undefined ? `${(hex.length - 2) / 2} bytes` : hex;
          plainly.push(`  ${field.name} @${field.offset}: ${shown}`);
        }
        const srcDomain = get("sourceDomain");
        if (f.localDomain && srcDomain) verdicts.push(compare("sourceDomain in a real message vs the docs' Pharos domain", f.localDomain, asNumber(srcDomain)));
        const ver = get("version");
        if (f.version && ver) verdicts.push(compare("version in a real message vs the docs' 'use 1'", f.version, asNumber(ver)));
        const sender = get("sender");
        if (f.messenger && sender) verdicts.push(compare("sender in a real message vs TokenMessengerV2 in the docs", f.messenger, asAddress(sender)));
        const nonce = get("nonce");
        if (nonce && f.nonceNote) {
          verdicts.push({ mark: "NOTE", topic: `nonce in the message as it leaves Pharos is ${/^0x0*$/.test(nonce) ? "all zeros" : nonce}`, docs: f.nonceNote, chainValue: nonce });
        }
      } else if (!sheet.log) {
        verdicts.push({ mark: "NOTE", topic: "no real MessageSent found in the last 10,000 blocks to compare with" });
      }
      return { key: sheet.key, subject: sheet.subject, verdicts, plainly };
    },
  };
}

// ------------------------------------------------------------------ any function the user names

export interface AnyCall {
  to: string;
  signature: string;
  returns?: string;
  args: string[];
}

function functionItem(signature: string, returns?: string): AbiFunction {
  const text = `function ${signature.trim()}${returns ? ` view returns (${returns})` : ""}`;
  return parseAbiItem(text) as AbiFunction;
}

function argFor(type: string, raw: string): unknown {
  if (/^u?int\d*$/.test(type)) return BigInt(raw);
  if (type === "bool") return raw === "true";
  return raw;
}

/** Function signatures the docs write out, like `latestAnswer()` or `balanceOf(address)`, with their selectors. */
export function functionsNamedIn(pages: { url: string; title: string; text: string }[]): { signature: string; selector: string; quote: Quote }[] {
  const found = new Map<string, { signature: string; selector: string; quote: Quote }>();
  const TYPE = /^(u?int\d*|address|bool|bytes\d*|string)(\[\d*\])*$/;
  for (const page of pages) {
    for (const raw of page.text.split("\n")) {
      for (const m of raw.matchAll(/\b([a-zA-Z_]\w*)\(([^()]*)\)/g)) {
        const params = m[2]!.trim() === "" ? [] : m[2]!.split(",").map((p) => p.trim().split(/\s+/)[0] ?? "");
        if (!params.every((p) => TYPE.test(p))) continue;
        const signature = `${m[1]}(${params.join(",")})`;
        if (found.has(signature)) continue;
        found.set(signature, { signature, selector: toFunctionSelector(signature), quote: { url: page.url, title: page.title, text: raw.trim() } });
      }
    }
  }
  return [...found.values()];
}

export function anyFunction(call: AnyCall): Target {
  const item = functionItem(call.signature, call.returns);
  const me = { key: `fn-${call.to.toLowerCase().slice(0, 10)}-${item.name}`, subject: `${item.name} on ${getAddress(call.to)}` };
  return {
    ...me,
    plan: () => ({ ...me, searches: [item.name, call.to], needles: [`${item.name}(`, call.to] }),
    async fire(chain, _brief, head) {
      const data = encodeFunctionData({ abi: [item], functionName: item.name, args: item.inputs.map((input, i) => argFor(input.type, call.args[i] ?? "")) });
      return sheetOf(me, head, [await shoot(chain, `${item.name}(...)`, { to: call.to, data }, head)]);
    },
    judge(brief, sheet) {
      const verdicts: Verdict[] = [];
      const plainly: string[] = [];
      const named = brief.quotes.find((q) => q.text.includes(`${item.name}(`));
      const listed = brief.quotes.find((q) => q.text.toLowerCase().includes(call.to.toLowerCase()));
      verdicts.push(named ? { mark: "NOTE", topic: `the docs name ${item.name}`, docs: named } : { mark: "DOCS SILENT", topic: `no docs page found names ${item.name}` });
      verdicts.push(listed ? { mark: "NOTE", topic: "the docs list this contract", docs: listed } : { mark: "DOCS SILENT", topic: "no docs page found lists this contract address" });
      const shot = sheet.shots[0];
      if (shot?.ok && shot.result) {
        let shown = shot.result;
        if (item.outputs.length > 0) {
          shown = String(decodeFunctionResult({ abi: [item], functionName: item.name, data: shot.result as `0x${string}` }));
        }
        verdicts.push({ mark: "NOTE", topic: `${item.name} answered`, chainValue: shown });
      } else {
        verdicts.push({ mark: "CHAIN SAYS NO", topic: `${item.name} reverted`, chainValue: shot?.reason ?? "no reason given" });
      }
      return { key: sheet.key, subject: sheet.subject, verdicts, plainly };
    },
  };
}

// ------------------------------------------------------------------ a real transaction from the latest blocks

export interface Sighting {
  tx: RawTx;
  looked: number;
  empty: number;
  noCalldata: number;
}

/** Walks back from the head and stops at the first transaction that actually calls a function. */
export async function firstCallInBlocks(chain: ToolLine, head: number, maxBlocks: number): Promise<Sighting | undefined> {
  let empty = 0;
  let noCalldata = 0;
  for (let i = 0; i < maxBlocks; i++) {
    const block = await blockWithTxs(chain, head - i);
    if (block.transactions.length === 0) empty++;
    for (const tx of block.transactions) {
      if (tx.to && tx.input && tx.input.length >= 10) return { tx, looked: i + 1, empty, noCalldata };
      noCalldata++;
    }
  }
  return undefined;
}

export function seenTx(tx: RawTx): Target {
  const to = tx.to ?? "";
  const selector = tx.input.slice(0, 10);
  const me = { key: `tx-${tx.hash.slice(2, 12)}`, subject: `selector ${selector} called on ${to} in tx ${tx.hash}` };
  return {
    ...me,
    plan: () => ({ ...me, searches: [to, selector, `function selector ${selector}`], needles: [to, selector] }),
    async fire(chain, _brief, _head) {
      // Replay it as the original sender on top of the block before, so the state is what that sender saw.
      const before = Number(tx.blockNumber) - 1;
      const shot = await shoot(chain, `replay of ${selector}`, { to, data: tx.input, from: tx.from, value: tx.value }, before);
      return sheetOf(me, before, [shot], { from: tx.from, hash: tx.hash });
    },
    judge(brief, sheet) {
      const verdicts: Verdict[] = [];
      const plainly: string[] = [];
      const listed = brief.quotes.find((q) => q.text.toLowerCase().includes(to.toLowerCase()));
      verdicts.push(listed ? { mark: "NOTE", topic: "the docs list this contract", docs: listed } : { mark: "DOCS SILENT", topic: `no docs page found lists ${to}` });
      const named = functionsNamedIn(brief.pages).find((fn) => fn.selector === selector);
      verdicts.push(
        named
          ? { mark: "MATCH", topic: `selector ${selector} is ${named.signature}, as written in the docs`, docs: named.quote, docsValue: named.signature, chainValue: selector }
          : { mark: "DOCS SILENT", topic: `no function the docs write out has selector ${selector}`, chainValue: selector },
      );
      const shot = sheet.shots[0];
      verdicts.push(
        shot?.ok
          ? { mark: "NOTE", topic: `replayed as ${sheet.notes.from} at block ${sheet.block}: it goes through`, chainValue: shot.result && shot.result.length > 2 ? `${(shot.result.length - 2) / 2} bytes back` : "no return data" }
          : { mark: "CHAIN SAYS NO", topic: `replayed as ${sheet.notes.from} at block ${sheet.block}`, chainValue: shot?.reason ?? "reverted without a reason" },
      );
      if (!listed && !named) plainly.push("The docs say nothing about this contract or this function, so there is nothing to explain it with.");
      return { key: sheet.key, subject: sheet.subject, verdicts, plainly };
    },
  };
}

export async function targetForTx(chain: ToolLine, hash: string): Promise<Target> {
  return seenTx(await txByHash(chain, hash));
}
