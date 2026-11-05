import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHAIN_MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";

// The Chain MCP lets one IP make 120 calls a minute; we stay a little under it so we never meet the 429.
const MIN_INTERVAL_MS = 60_000 / 115;
const MAX_ATTEMPTS = 4;

/**
 * The only tools receipts is allowed to touch. Every one of them reads. The server also offers
 * send_raw_transaction and estimate_gas; we refuse those before a single byte leaves the machine.
 */
export const READ_TOOLS = new Set([
  "get_chain_info",
  "get_block_number",
  "get_block",
  "get_balance",
  "get_code",
  "get_transaction",
  "get_transaction_receipt",
  "eth_call",
]);

type TextContent = { type: string; text?: string };

/** Anything that can answer a Chain MCP tool call with raw text. The real server and the test fakes both fit. */
export interface ToolLine {
  ask(tool: string, args: Record<string, unknown>): Promise<string>;
}

/** Someone asked for a tool that could change the chain. receipts never does that. */
export class NotAllowed extends Error {
  constructor(readonly tool: string) {
    super(`receipts is read-only: refusing to call ${tool}`);
  }
}

export function guardTool(tool: string): void {
  if (!READ_TOOLS.has(tool)) throw new NotAllowed(tool);
}

/** A paced client for the hosted Chain MCP, read tools only. */
export class McpLine implements ToolLine {
  private readonly client = new Client({ name: "receipts", version: "1.0.0" });
  private nextSlot = 0;
  private connected = false;
  /** How many calls actually went out, so the CLI can say what an answer cost. */
  calls = 0;

  constructor(private readonly url = CHAIN_MCP_URL) {}

  async ask(tool: string, args: Record<string, unknown>): Promise<string> {
    guardTool(tool);
    if (!this.connected) {
      await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      this.connected = true;
    }
    for (let attempt = 1; ; attempt++) {
      await this.waitTurn();
      this.calls++;
      try {
        const res = await this.client.callTool({ name: tool, arguments: args });
        const text = (res.content as TextContent[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        if (res.isError) throw new ToolSaidNo(tool, text);
        return text;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !worthRetrying(err)) throw err;
        await sleep(1000 * attempt);
      }
    }
  }

  async close(): Promise<void> {
    if (this.connected) await this.client.close();
  }

  private async waitTurn(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
  }
}

/** The server answered, but with an error (a revert, a bad argument, an unknown tx). */
export class ToolSaidNo extends Error {
  constructor(readonly tool: string, readonly body: string) {
    super(`Chain MCP ${tool} failed: ${body.slice(0, 300)}`);
  }

  /** The EVM itself said no, as opposed to the server or the network. */
  get isRevert(): boolean {
    return /execution reverted/i.test(this.body);
  }
}

function worthRetrying(err: unknown): boolean {
  if (err instanceof ToolSaidNo) {
    // A brand new block may not have reached every node behind the load balancer yet.
    return /block is not available|header not found|RPC HTTP (429|5\d\d)/i.test(err.body);
  }
  const msg = String((err as Error)?.message ?? err);
  return /429|Too Many Requests|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|5\d\d/.test(msg);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
