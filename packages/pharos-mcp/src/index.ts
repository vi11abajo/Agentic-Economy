import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const PHAROS_MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";

// Pharos MCP allows 120 requests per minute per IP (fixed 60s window, HTTP 429 above it).
const MIN_INTERVAL_MS = 60_000 / 115;
const MAX_ATTEMPTS = 5;

type TextContent = { type: string; text?: string };

/** One completed MCP tool call, as sent and as answered (raw text from the server). */
export interface McpCallRecord {
  tool: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  response: string;
  ms: number;
}

/** Thin wrapper around the hosted Pharos Chain MCP server (mcp.pharos.xyz). */
export class PharosMcp {
  private readonly client: Client;
  private nextSlot = 0;
  calls = 0;
  /** Optional hook called after every answered tool call (used for --trace). */
  onCall?: (record: McpCallRecord) => void;

  constructor(clientName = "agentic-economy") {
    this.client = new Client({ name: clientName, version: "1.0.0" });
  }

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(PHAROS_MCP_URL)));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  /** Calls an MCP tool and returns its JSON payload. */
  async call<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      await this.pace();
      try {
        const started = Date.now();
        const res = await this.client.callTool({ name, arguments: args });
        this.calls++;
        const text = (res.content as TextContent[]).find((c) => c.type === "text")?.text ?? "";
        this.onCall?.({ tool: name, arguments: args, isError: Boolean(res.isError), response: text, ms: Date.now() - started });
        if (res.isError) throw new McpToolError(name, text);
        return JSON.parse(text) as T;
      } catch (err) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(err)) throw err;
        await sleep(1000 * attempt);
      }
    }
  }

  private async pace(): Promise<void> {
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot);
    this.nextSlot = slot + MIN_INTERVAL_MS;
    if (slot > now) await sleep(slot - now);
  }
}

export class McpToolError extends Error {
  constructor(readonly tool: string, readonly body: string) {
    super(`${tool} failed: ${body.slice(0, 300)}`);
  }

  /** True when the EVM call itself reverted (e.g. the contract does not implement the function). */
  get isRevert(): boolean {
    return /execution reverted/i.test(this.body);
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof McpToolError) {
    // The newest block may not have reached every RPC node behind the load balancer yet.
    return /block is not available|header not found|RPC HTTP (429|5\d\d)/i.test(err.body);
  }
  const msg = String((err as Error)?.message ?? err);
  return /429|Too Many Requests|ECONNRESET|ETIMEDOUT|fetch failed|5\d\d/.test(msg);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
