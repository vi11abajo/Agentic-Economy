import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const CHAIN_MCP_URL = process.env.PHAROS_MCP_URL ?? "https://mcp.pharos.xyz/mcp";
export const DOCS_MCP_URL = process.env.PHAROS_DOCS_MCP_URL ?? "https://docs.pharos.xyz/~gitbook/mcp";

// The Chain MCP lets one IP make 120 calls a minute. The docs server never told us its limit, so both get the
// same polite pace and nobody has to think about it again.
const MIN_INTERVAL_MS = 60_000 / 115;
const MAX_ATTEMPTS = 4;

type TextContent = { type: string; text?: string };

/** One answered tool call: what we asked, what came back, how long it took. Feeds the live trace. */
export interface CallNote {
  server: "docs" | "chain";
  tool: string;
  args: Record<string, unknown>;
  failed: boolean;
  answer: string;
  ms: number;
}

/** Anything that can answer an MCP tool call with raw text. The real servers and the test fakes both fit. */
export interface ToolLine {
  readonly server: "docs" | "chain";
  ask(tool: string, args: Record<string, unknown>): Promise<string>;
}

/** A paced client for one hosted MCP server. */
export class McpLine implements ToolLine {
  private readonly client: Client;
  private nextSlot = 0;
  private connected = false;
  /** Called after every answered call, so the CLI can print the trace while the work happens. */
  onCall?: (note: CallNote) => void;

  constructor(readonly server: "docs" | "chain", private readonly url: string) {
    this.client = new Client({ name: `nerd-${server}`, version: "1.0.0" });
  }

  async ask(tool: string, args: Record<string, unknown>): Promise<string> {
    if (!this.connected) {
      await this.client.connect(new StreamableHTTPClientTransport(new URL(this.url)));
      this.connected = true;
    }
    for (let attempt = 1; ; attempt++) {
      await this.waitTurn();
      const started = Date.now();
      try {
        const res = await this.client.callTool({ name: tool, arguments: args });
        const text = (res.content as TextContent[]).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");
        const failed = Boolean(res.isError);
        this.onCall?.({ server: this.server, tool, args, failed, answer: text, ms: Date.now() - started });
        if (failed) throw new ToolSaidNo(this.server, tool, text);
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

/** The server answered, but with an error (a revert, a bad argument, a missing page). */
export class ToolSaidNo extends Error {
  constructor(readonly server: string, readonly tool: string, readonly body: string) {
    super(`${server} MCP ${tool} failed: ${body.slice(0, 300)}`);
  }

  /** The EVM itself said no, as opposed to the server or the network. */
  get isRevert(): boolean {
    return /execution reverted/i.test(this.body);
  }

  /** The revert string, when the contract gave one ("Domain is local domain"). */
  get revertReason(): string | undefined {
    const m = /execution reverted:?\s*([^"\n,]*)/i.exec(this.body);
    const reason = m?.[1]?.trim();
    return reason ? reason : undefined;
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
