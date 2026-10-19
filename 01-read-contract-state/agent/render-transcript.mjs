// Turns the stream-json transcripts in a folder into one readable Markdown conversation:
// prompt -> every Pharos MCP tool call (name + arguments) -> raw tool result -> agent answer.
// Usage: node render-transcript.mjs transcripts > TRANSCRIPT.md
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2] ?? "transcripts";
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
const out = ["# Agent transcript: Claude Code + Pharos Chain MCP", ""];

for (const file of files) {
  const events = readFileSync(join(dir, file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const init = events.find((e) => e.type === "system" && e.subtype === "init");
  const result = [...events].reverse().find((e) => e.type === "result");
  const prompt = readFileSync(join(dir, "..", "prompts", file.replace(/\.jsonl$/, ".txt")), "utf8").trim();

  out.push(`## ${file.replace(/\.jsonl$/, "")}`, "", `**You:** ${prompt}`, "");
  if (init && file === files[0]) {
    const servers = (init.mcp_servers ?? []).map((s) => `${s.name} (${s.status})`).join(", ");
    const mcpTools = (init.tools ?? []).filter((t) => t.startsWith("mcp__"));
    out.push(`MCP servers: ${servers || "none"}`, "", `Agent tools: ${mcpTools.join(", ") || "none"}`, "");
  }

  const toolNames = new Map();
  for (const e of events) {
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (e.type === "assistant" && block.type === "tool_use") {
        toolNames.set(block.id, block.name);
        if (block.name === "ToolSearch") {
          // Claude Code loads deferred tool schemas before first use; not a chain call.
          out.push(`_(loads tool schemas: ${block.input?.query ?? ""})_`, "");
          continue;
        }
        out.push(`**Tool call:** \`${block.name}\``, "", "```json", JSON.stringify(block.input, null, 2), "```", "");
      } else if (e.type === "user" && block.type === "tool_result") {
        const name = toolNames.get(block.tool_use_id) ?? "";
        if (name !== "Bash" && !name.startsWith("mcp__")) continue;
        const text = Array.isArray(block.content)
          ? block.content.map((c) => c.text ?? "").join("\n")
          : String(block.content ?? "");
        const label = name === "Bash" ? "Command output" : "MCP result";
        out.push(`**${label}** (\`${name}\`):`, "", "```text", text.trim(), "```", "");
      }
    }
  }

  if (result) {
    out.push(`**Agent:** ${String(result.result ?? "").trim()}`, "");
    const meta = [
      result.num_turns !== undefined ? `${result.num_turns} turns` : null,
      result.duration_ms !== undefined ? `${(result.duration_ms / 1000).toFixed(1)} s` : null,
    ].filter(Boolean);
    if (meta.length) out.push(`_${meta.join(" · ")}_`, "");
  }
}

process.stdout.write(out.join("\n"));
