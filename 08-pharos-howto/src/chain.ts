// Everything on chain goes through the Pharos Chain MCP (mcp.pharos.xyz): reads, gas estimates, nonces,
// and broadcasting a transaction that was signed here. The MCP server never sees a key.
import { PharosMcp, McpToolError } from "@agentic-economy/pharos-mcp";
import type { Address, Hex } from "viem";

export interface Log {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber?: string;
  transactionHash?: Hex;
}

export interface Receipt {
  hash: Hex;
  status: "success" | "reverted";
  block: bigint;
  from: Address;
  to: Address | null;
  gasUsed: bigint;
  effectiveGasPrice: bigint;
  logs: Log[];
}

export interface TxInfo {
  from: Address;
  to: Address | null;
  gas: bigint;
  value: bigint;
  input: Hex;
}

/** What the runner needs from the chain (a fake one is used in tests). */
export interface Chain {
  gasPrice(): Promise<{ gasPrice: bigint; priority: bigint }>;
  balance(address: Address, block?: bigint): Promise<bigint>;
  call(to: Address, data: Hex, block?: bigint): Promise<Hex>;
  estimateGas(tx: { from: Address; to: Address; data?: Hex; value?: bigint }): Promise<bigint>;
  nonce(address: Address): Promise<number>;
  sendRaw(raw: Hex): Promise<Hex>;
  receipt(hash: Hex): Promise<Receipt | null>;
  transaction(hash: Hex): Promise<TxInfo | null>;
  code(address: Address): Promise<Hex>;
  logs(filter: { address?: Address; topics?: (Hex | null)[]; fromBlock: bigint; toBlock: bigint }): Promise<Log[]>;
  blockNumber(): Promise<bigint>;
  close(): Promise<void>;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;
const big = (s: string | number | undefined | null) => (s === undefined || s === null ? 0n : BigInt(s));
const blockArg = (b?: bigint) => (b === undefined ? {} : { block: Number(b) });
const notFound = (e: unknown) => e instanceof McpToolError && /not found|could not be found|null/i.test(e.body);

/** The hosted Chain MCP, paced to its 120 requests a minute. */
export class ChainMcp implements Chain {
  private constructor(private readonly mcp: PharosMcp) {}

  static async open(): Promise<ChainMcp> {
    const mcp = new PharosMcp("pharos-howto");
    await mcp.connect();
    return new ChainMcp(mcp);
  }

  close(): Promise<void> {
    return this.mcp.close();
  }

  private async call_<T>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
    const r = await this.mcp.call<T & { error?: { message?: string } }>(tool, args);
    if (r && typeof r === "object" && "error" in r && r.error) throw new McpToolError(tool, String(r.error.message ?? JSON.stringify(r.error)));
    return r;
  }

  async gasPrice() {
    const r = await this.call_<{ gasPriceWei: string; maxPriorityFeePerGasWei: string }>("get_gas_price");
    return { gasPrice: big(r.gasPriceWei), priority: big(r.maxPriorityFeePerGasWei) };
  }

  async balance(address: Address, block?: bigint) {
    return big((await this.call_<{ balanceWei: string }>("get_balance", { address, ...blockArg(block) })).balanceWei);
  }

  async call(to: Address, data: Hex, block?: bigint) {
    return (await this.call_<{ result: Hex }>("eth_call", { transaction: { to, data }, ...blockArg(block) })).result;
  }

  async estimateGas(tx: { from: Address; to: Address; data?: Hex; value?: bigint }) {
    const r = await this.call_<{ gas: string }>("estimate_gas", { transaction: { from: tx.from, to: tx.to, data: tx.data, value: hex(tx.value ?? 0n) } });
    return big(r.gas);
  }

  async nonce(address: Address) {
    return Number((await this.call_<{ nonce: string }>("get_transaction_count", { address, block: "pending" })).nonce);
  }

  async sendRaw(raw: Hex) {
    const r = await this.call_<Record<string, unknown>>("send_raw_transaction", { rawTransaction: raw });
    const h = (r.txHash ?? r.transactionHash ?? r.hash ?? r.result) as Hex | undefined; // the hosted MCP answers {txHash}
    if (!h) throw new Error(`send_raw_transaction gave no hash: ${JSON.stringify(r).slice(0, 200)}`);
    return h;
  }

  async receipt(hash: Hex): Promise<Receipt | null> {
    const r = await this.call_<Record<string, unknown> | null>("get_transaction_receipt", { hash }).catch((e) => {
      if (notFound(e)) return null;
      throw e;
    });
    if (!r || !r.blockNumber) return null;
    return {
      hash,
      status: big(r.status as string) === 1n ? "success" : "reverted",
      block: big(r.blockNumber as string),
      from: r.from as Address,
      to: (r.to as Address) ?? null,
      gasUsed: big(r.gasUsed as string),
      effectiveGasPrice: big(r.effectiveGasPrice as string),
      logs: (r.logs as Log[]) ?? [],
    };
  }

  async transaction(hash: Hex): Promise<TxInfo | null> {
    const r = await this.call_<Record<string, unknown> | null>("get_transaction", { hash }).catch((e) => {
      if (notFound(e)) return null;
      throw e;
    });
    if (!r || !r.from) return null;
    return { from: r.from as Address, to: (r.to as Address) ?? null, gas: big(r.gas as string), value: big(r.value as string), input: r.input as Hex };
  }

  async code(address: Address) {
    const r = await this.call_<{ code?: Hex; result?: Hex; bytecode?: Hex }>("get_code", { address });
    return (r.code ?? r.bytecode ?? r.result ?? "0x") as Hex;
  }

  async logs(f: { address?: Address; topics?: (Hex | null)[]; fromBlock: bigint; toBlock: bigint }) {
    const r = await this.call_<Log[] | { logs: Log[] }>("get_logs", { address: f.address, topics: f.topics, fromBlock: Number(f.fromBlock), toBlock: Number(f.toBlock) });
    return Array.isArray(r) ? r : r.logs;
  }

  async blockNumber() {
    const r = await this.call_<Record<string, string>>("get_block_number");
    return big(r.blockNumber ?? r.number ?? r.latestBlock);
  }
}
