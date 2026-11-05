import { ToolSaidNo, type ToolLine } from "./mcp.js";

type Answer = string | ((args: Record<string, unknown>) => string);

/**
 * A pretend MCP server for tests: answers from a table, remembers every question in order. A function answer can
 * throw to play a revert. Unknown tools fail loudly so a test never passes by accident.
 */
export class ScriptedLine implements ToolLine {
  readonly asked: { tool: string; args: Record<string, unknown> }[] = [];

  constructor(readonly server: "docs" | "chain", private readonly answers: Record<string, Answer>) {}

  async ask(tool: string, args: Record<string, unknown>): Promise<string> {
    this.asked.push({ tool, args });
    const answer = this.answers[tool];
    if (answer === undefined) throw new Error(`fake ${this.server} MCP has no answer for ${tool}`);
    return typeof answer === "function" ? answer(args) : answer;
  }
}

/** What the real Chain MCP sends back when the EVM reverts with a reason. */
export function revertWith(reason: string): never {
  throw new ToolSaidNo("chain", "eth_call", JSON.stringify({ error: { message: `execution reverted: ${reason}`, code: 3, data: "0x" } }));
}
