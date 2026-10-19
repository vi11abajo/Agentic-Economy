// Client for the Pharos Developer Docs MCP (GitBook MCP over docs.pharos.xyz). Its tools answer in plain text.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export const DOCS_MCP_URL = process.env.PHAROS_DOCS_MCP_URL ?? "https://docs.pharos.xyz/~gitbook/mcp";

/** What the CLI needs from the docs server (a fake one is used in tests). */
export interface DocsSource {
  ask(question: string): Promise<string>;
  search(query: string): Promise<string>;
  page(url: string): Promise<string>;
}

export class DocsMcp implements DocsSource {
  private readonly client = new Client({ name: "rtfm", version: "1.0.0" });

  async connect(): Promise<void> {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(DOCS_MCP_URL)));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  ask(question: string): Promise<string> {
    return this.text("askQuestion", {
      question,
      goal: "Answer a developer's question about building on Pharos, from the terminal",
    });
  }

  search(query: string): Promise<string> {
    return this.text("searchDocumentation", { query });
  }

  page(url: string): Promise<string> {
    return this.text("getPage", { url });
  }

  private async text(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
    if (res.isError) throw new Error(`Docs MCP ${name} failed: ${text.slice(0, 300)}`);
    return text;
  }
}
