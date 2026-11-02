// The diagnosis: take a hash, gather the clues, and decide what kind of failure this was. Every fact we state is
// something the chain answered, read at the block the transaction lived in. When a read doesn't come back, we say
// "unknown" rather than pretend it was zero.
import { decodeFunctionData, decodeFunctionResult, encodeFunctionData, formatUnits, parseAbi, type Abi, type Hex } from "viem";
import { readTheRevert, whereItBroke, type BreakingPoint, type Revert } from "./clues.js";
import type { CallSpec, Echo, Tx, Witness } from "./witness.js";

export type Kind =
  | "not_failed"
  | "deployment_failed"
  | "out_of_gas"
  | "same_block"
  | "slippage"
  | "deadline"
  | "allowance"
  | "balance"
  | "vault_liquidity"
  | "contract_short"
  | "unauthorized"
  | "other_revert";

export interface TokenAmount {
  token: string;
  symbol: string;
  raw: bigint;
  pretty: string;
}

export interface Neighbour {
  index: number;
  hash: string;
  from: string;
  to: string | null;
  sameSender: boolean;
}

export interface Autopsy {
  hash: string;
  tx: Tx;
  block: number;
  kind: Kind;
  /** What the outermost contract said, and what the one that really broke said (often a token deep inside). */
  said: Revert;
  deepest?: Revert;
  where?: BreakingPoint;
  calledFunction?: string;
  brokenFunction?: string;
  gasLimit: bigint;
  gasUsed: bigint;
  /** Kind-specific numbers: needed vs had, the deadline, what the vault had in cash... */
  facts: Record<string, unknown>;
  /** Earlier transactions in the same block that touched the same contract or came from the same sender. */
  neighbours?: Neighbour[];
}

export const erc20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function transfer(address,uint256) returns (bool)",
  "function transferFrom(address,address,uint256) returns (bool)",
]);
const vault4626 = parseAbi(["function asset() view returns (address)"]);
const NOBODY = "0x0000000000000000000000000000000000000000";
const UNLIMITED = 2n ** 255n;

/**
 * A small read-only call: "what did this contract say about that, at that block?". A revert or an answer we can't
 * decode gives undefined; a node that can't answer at all throws, because that's not a fact about the chain.
 */
export async function peek<T>(witness: Witness, to: string, abi: Abi, fn: string, args: unknown[], block: number | "latest"): Promise<T | undefined> {
  if (!to) return undefined;
  const data = encodeFunctionData({ abi, functionName: fn as never, args: args as never });
  const echo = await witness.replay({ from: NOBODY, to, data }, block);
  if (echo.reverted) return undefined;
  try {
    return decodeFunctionResult({ abi, functionName: fn as never, data: echo.returned as Hex }) as T;
  } catch {
    return undefined; // no code there, or a token whose symbol() is bytes32: just don't use it
  }
}

export async function tokenAmount(witness: Witness, token: string, raw: bigint): Promise<TokenAmount> {
  const symbol = (await peek<string>(witness, token, erc20, "symbol", [], "latest")) ?? `${token.slice(0, 8)}…`;
  const decimals = Number((await peek<number>(witness, token, erc20, "decimals", [], "latest")) ?? 18);
  const pretty = raw >= UNLIMITED ? `unlimited ${symbol}` : `${Number(formatUnits(raw, decimals)).toLocaleString("en-US", { maximumFractionDigits: 6 })} ${symbol}`;
  return { token, symbol, raw, pretty };
}

const SELECTOR_TRANSFER = "0xa9059cbb";
const SELECTOR_TRANSFER_FROM = "0x23b872dd";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const pad32 = (address: string) => `0x${address.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
const same = (x?: string | null, y?: string | null) => !!x && !!y && x.toLowerCase() === y.toLowerCase();

export const callOf = (tx: Tx): CallSpec => ({ from: tx.from, to: tx.to ?? NOBODY, data: tx.input, value: tx.value, gas: tx.gas });

function bySaying(said: Revert): Kind | undefined {
  const words = `${said.name} ${said.message ?? ""}`;
  if (said.name === "Slippage" || /too little received|too much requested|slippage|insufficient output|min.?out/i.test(words)) return "slippage";
  if (/too old|expired|deadline/i.test(words)) return "deadline";
  if (said.name === "ERC20InsufficientAllowance" || /allowance/i.test(words)) return "allowance";
  if (said.name === "ERC20InsufficientBalance" || /exceeds balance|insufficient balance|insufficient funds/i.test(words)) return "balance";
  if (/Unauthorized|OwnableUnauthorizedAccount/.test(said.name) || /not owner|unauthori[sz]ed|only owner|access denied/i.test(words)) return "unauthorized";
  return undefined;
}

/**
 * "Did these exact tokens already leave this wallet a little earlier?" We scan the last ~2,000 blocks of the
 * token's Transfer events from the owner to the same receiver and pick one with the same amount. That's the
 * classic double send. Matching the receiver too keeps round amounts from colliding by chance.
 */
async function sameAmountLeftEarlier(witness: Witness, token: string, owner: string, receiver: string, amount: bigint, block: number) {
  for (let toBlock = block - 1, round = 0; round < 2; round++, toBlock -= 1000) {
    const lines = await witness.logs({ address: token, topics: [TRANSFER_TOPIC, pad32(owner), pad32(receiver)], fromBlock: Math.max(0, toBlock - 999), toBlock });
    const twin = [...lines].reverse().find((l) => BigInt(l.data) === amount);
    if (twin) return { tx: twin.transactionHash, block: Number(BigInt(twin.blockNumber)), blocksEarlier: block - Number(BigInt(twin.blockNumber)) };
  }
  return undefined;
}

const succeeded = (status: unknown) => status === "0x1" || status === "success" || status === 1 || status === "1";

/** Give an unknown error a name from the public signature list, if anyone ever published it. */
async function named(witness: Witness, revert: Revert | undefined): Promise<Revert | undefined> {
  if (!revert || revert.name !== "unknown") return revert;
  const name = await witness.nameOf(revert.selector, "error");
  return name ? { ...revert, name: name.replace(/\(.*$/, ""), message: name } : revert;
}

export async function performAutopsy(witness: Witness, hash: string): Promise<Autopsy> {
  const tx = await witness.transaction(hash);
  if (!tx) throw new Error(`no transaction ${hash} on Pharos mainnet`);
  const receipt = await witness.receipt(hash);
  if (!receipt) throw new Error(`transaction ${hash} is not mined yet`);
  const block = Number(BigInt(tx.blockNumber));
  const gasLimit = BigInt(tx.gas);
  const gasUsed = BigInt(receipt.gasUsed);
  const quiet: Revert = { name: "none", selector: "0x", args: [] };
  const base = { hash, tx, block, gasLimit, gasUsed, facts: {} as Record<string, unknown> };
  if (succeeded(receipt.status)) return { ...base, kind: "not_failed", said: quiet };

  // The trace tells us which contract really said no. If the trace endpoint is down, we carry on without it.
  const trace = await witness.trace(hash).catch(() => null);
  const where = trace ? whereItBroke(trace) : undefined;

  // A deployment has no address to replay against; its own trace is all we have.
  if (!tx.to) {
    const said = (await named(witness, readTheRevert(trace?.output))) ?? quiet;
    return { ...base, kind: "deployment_failed", said, where, facts: { outOfGas: /out.?of.?gas/i.test(where?.error ?? "") } };
  }

  const call = callOf(tx);
  // Replaying just before the block is our MCP-only view; it can differ from what happened inside the block.
  const before: Echo = await witness.replay(call, block - 1);
  const said = (await named(witness, readTheRevert(trace?.output ?? (before.reverted ? before.revertData : "0x"))))!;
  const deepest = where && where.depth > 0 ? await named(witness, readTheRevert(where.output)) : undefined;
  const calledFunction = (await witness.nameOf(tx.input.slice(0, 10), "function")) ?? undefined;
  const brokenFunction = where && where.depth > 0 ? ((await witness.nameOf(where.input.slice(0, 10), "function")) ?? undefined) : undefined;
  const autopsy: Autopsy = { ...base, kind: "other_revert", said, deepest, where, calledFunction, brokenFunction };
  const theWords = bySaying(said) ?? (deepest ? bySaying(deepest) : undefined);

  // 1) Ran dry: the deepest frame says so. Without a trace, burning (almost) all gas with no reason is our hint.
  const ranDry = where ? /out.?of.?gas/i.test(where.error ?? "") : gasUsed * 100n >= gasLimit * 97n && said.name === "silence";
  if (ranDry) {
    autopsy.kind = "out_of_gas";
    autopsy.facts = { gasLimit, gasUsed };
    return autopsy;
  }

  // 2) A deadline speaks for itself, even when the block before was still within it.
  if (theWords === "deadline") {
    autopsy.kind = "deadline";
    autopsy.facts = { blockTime: (await witness.block(block)).timestamp };
    return autopsy;
  }

  // 3) It works on the state right before the block but failed inside it: something earlier in the block changed things.
  if (!before.reverted) {
    autopsy.kind = "same_block";
    const theBlock = await witness.block(block);
    const myIndex = Number(BigInt(tx.transactionIndex));
    autopsy.neighbours = theBlock.transactions
      .filter((t) => Number(BigInt(t.transactionIndex)) < myIndex && (same(t.to, tx.to) || same(t.from, tx.from)))
      .map((t) => ({ index: Number(BigInt(t.transactionIndex)), hash: t.hash, from: t.from, to: t.to, sameSender: same(t.from, tx.from) }));
    autopsy.facts = { indexInBlock: myIndex, whatItSaid: theWords };
    return autopsy;
  }

  // 4) A token transfer deep inside bounced: look at who was short of what, at that block.
  const tokenMove = where && where.depth > 0 && [SELECTOR_TRANSFER, SELECTOR_TRANSFER_FROM].includes(where.input.slice(0, 10)) ? where : undefined;
  let moveArgs: { functionName: string; args: readonly unknown[] } | undefined;
  try {
    moveArgs = tokenMove ? decodeFunctionData({ abi: erc20, data: tokenMove.input as Hex }) : undefined;
  } catch {
    moveArgs = undefined;
  }
  if (tokenMove && moveArgs) {
    const token = tokenMove.to;
    if (moveArgs.functionName === "transferFrom") {
      const [owner, receiver, amount] = moveArgs.args as [string, string, bigint];
      const spender = tokenMove.from;
      const balance = await peek<bigint>(witness, token, erc20, "balanceOf", [owner], block - 1);
      const allowance = await peek<bigint>(witness, token, erc20, "allowance", [owner, spender], block - 1);
      autopsy.facts = {
        owner,
        spender,
        needed: await tokenAmount(witness, token, amount),
        balance: balance === undefined ? "unknown" : await tokenAmount(witness, token, balance),
        allowance: allowance === undefined ? "unknown" : await tokenAmount(witness, token, allowance),
      };
      // If the token named its complaint, believe it; our reads only break the tie when it stayed quiet
      // (OpenZeppelin checks the allowance before the balance, so that's the order we use too).
      const tokenSaid = [deepest, said].map((r) => r && bySaying(r)).find((k) => k === "allowance" || k === "balance");
      const allowanceShort = allowance !== undefined && allowance < amount;
      const balanceShort = balance !== undefined && balance < amount;
      autopsy.kind = tokenSaid ?? (allowanceShort ? "allowance" : balanceShort ? "balance" : "other_revert");
      if (allowanceShort && balanceShort) autopsy.facts.alsoShort = autopsy.kind === "allowance" ? "balance" : "allowance";
      // Out of tokens usually means they already left: find the earlier move of the same amount to the same place.
      if (balanceShort) {
        const echo = await sameAmountLeftEarlier(witness, token, owner, receiver, amount, block);
        if (echo) autopsy.facts.alreadyMoved = echo;
      }
      if (autopsy.kind !== "other_revert") return autopsy;
    } else {
      const [, amount] = moveArgs.args as [string, bigint];
      const payer = tokenMove.from;
      const cash = await peek<bigint>(witness, token, erc20, "balanceOf", [payer], block - 1);
      if (cash !== undefined && cash < amount) {
        // Someone tried to pay out more than they held. If that's the user's own wallet, it's their balance; if it's
        // an ERC-4626 vault, the vault lacked idle cash; any other contract (a router, a market) just came up short.
        const isVault = !same(payer, tx.from) && (await peek<string>(witness, payer, vault4626, "asset", [], block - 1)) !== undefined;
        autopsy.kind = same(payer, tx.from) ? "balance" : isVault ? "vault_liquidity" : "contract_short";
        autopsy.facts = { payer, wanted: await tokenAmount(witness, token, amount), cash: await tokenAmount(witness, token, cash) };
        return autopsy;
      }
    }
  }

  // 5) Otherwise trust the words: the outermost message first, then the deepest one.
  autopsy.kind = theWords ?? "other_revert";
  if (autopsy.kind === "allowance" && said.name === "ERC20InsufficientAllowance" && where?.to) {
    const [spender, allowance, needed] = said.args as [string, bigint, bigint];
    autopsy.facts = { spender, owner: tx.from, needed: await tokenAmount(witness, where.to, needed), allowance: await tokenAmount(witness, where.to, allowance) };
  }
  return autopsy;
}
