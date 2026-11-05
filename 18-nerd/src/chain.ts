import { ToolSaidNo, type ToolLine } from "./mcp.js";

/** A transaction shape the Chain MCP takes for eth_call / estimate_gas. Nothing here is ever signed. */
export interface Ask {
  to: string;
  data: string;
  from?: string;
  value?: string;
}

/** One eth_call and how it went. A revert is an answer too, so it is kept, not thrown. */
export interface Shot {
  label: string;
  ask: Ask;
  block: string;
  ok: boolean;
  result?: string;
  reason?: string;
  raw?: string;
}

export interface RawLog {
  address: string;
  blockNumber: string;
  transactionHash: string;
  data: string;
  topics: string[];
}

export interface RawTx {
  hash: string;
  from: string;
  to: string | null;
  input: string;
  value: string;
  blockNumber: string;
}

/** The Chain MCP caps get_logs at 1,000 blocks per call (it says so in its error), so we page by that. */
export const LOG_WINDOW = 1000;

async function json<T>(chain: ToolLine, tool: string, args: Record<string, unknown>): Promise<T> {
  return JSON.parse(await chain.ask(tool, args)) as T;
}

export async function headBlock(chain: ToolLine): Promise<number> {
  const answer = await json<{ blockNumber: string }>(chain, "get_block_number", {});
  return Number(answer.blockNumber);
}

/** eth_call pinned to a block. Reverts come back as a Shot with ok=false and the contract's own reason. */
export async function shoot(chain: ToolLine, label: string, ask: Ask, block: number): Promise<Shot> {
  const transaction: Record<string, string> = { to: ask.to, data: ask.data };
  if (ask.from) transaction.from = ask.from;
  if (ask.value && ask.value !== "0x0" && ask.value !== "0") transaction.value = ask.value;
  try {
    const answer = await json<{ result: string }>(chain, "eth_call", { transaction, block: String(block) });
    return { label, ask, block: String(block), ok: true, result: answer.result };
  } catch (err) {
    if (err instanceof ToolSaidNo && err.isRevert) {
      return { label, ask, block: String(block), ok: false, reason: err.revertReason, raw: err.body };
    }
    throw err;
  }
}

/** estimate_gas, or the reason it could not be estimated (usually the same revert eth_call gave). */
export async function gasFor(chain: ToolLine, ask: Ask): Promise<{ gas?: number; reason?: string }> {
  const transaction: Record<string, string> = { to: ask.to, data: ask.data };
  if (ask.from) transaction.from = ask.from;
  try {
    const answer = await json<{ gas: string }>(chain, "estimate_gas", { transaction });
    return { gas: Number(answer.gas) };
  } catch (err) {
    if (err instanceof ToolSaidNo) return { reason: err.revertReason ?? err.body.slice(0, 200) };
    throw err;
  }
}

/**
 * The newest log with this topic from this contract, walking back from `head` one 1,000-block window at a time.
 * Gives up after `windows` windows and says so with undefined.
 */
export async function newestLog(
  chain: ToolLine,
  address: string,
  topic: string,
  head: number,
  windows = 10,
): Promise<RawLog | undefined> {
  for (let i = 0; i < windows; i++) {
    const toBlock = head - i * LOG_WINDOW;
    const fromBlock = toBlock - LOG_WINDOW + 1;
    const logs = await json<RawLog[]>(chain, "get_logs", {
      address,
      topics: [topic],
      fromBlock: String(fromBlock),
      toBlock: String(toBlock),
    });
    if (logs.length > 0) return logs[logs.length - 1];
  }
  return undefined;
}

export async function blockWithTxs(chain: ToolLine, block: number): Promise<{ number: number; timestamp: number; transactions: RawTx[] }> {
  const raw = await json<{ number: string; timestamp: string; transactions: RawTx[] }>(chain, "get_block", {
    block: String(block),
    includeTransactions: true,
  });
  return { number: Number(raw.number), timestamp: Number(raw.timestamp), transactions: raw.transactions ?? [] };
}

export async function txByHash(chain: ToolLine, hash: string): Promise<RawTx> {
  return json<RawTx>(chain, "get_transaction", { hash });
}
