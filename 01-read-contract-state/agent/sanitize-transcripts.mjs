// Keeps only what proves the agent's work from Claude Code's raw stream-json output:
// the model, the Pharos MCP server status and its tools, each tool call with its arguments, each result,
// the agent's text answers and the run stats. Other MCP servers/connectors, local paths, plugins, skills,
// hooks and other environment details of the machine that ran the agent are dropped or redacted.
// Usage: node sanitize-transcripts.mjs transcripts/raw transcripts
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [rawDir = "transcripts/raw", outDir = "transcripts"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

// Absolute local paths (Windows or MSYS style) become ./<file name>.
function redact(text) {
  return text
    .replace(/(^|[\s"'=])[A-Za-z]:[\\/][^\s"'`]*[\\/]([^\\/\s"'`]+)/g, "$1./$2")
    .replace(/(^|\s)\/[a-z]\/[^\s"'`]*\/([^/\s"'`]+)/g, "$1./$2");
}
function redactDeep(v) {
  if (typeof v === "string") return redact(v);
  if (Array.isArray(v)) return v.map(redactDeep);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)]));
  return v;
}

for (const file of readdirSync(rawDir).filter((f) => f.endsWith(".jsonl")).sort()) {
  const clean = [];
  for (const line of readFileSync(join(rawDir, file), "utf8").split("\n")) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.type === "system" && e.subtype === "init") {
      clean.push({
        type: "system",
        subtype: "init",
        model: e.model,
        claude_code_version: e.claude_code_version,
        mcp_servers: (e.mcp_servers ?? []).filter((m) => m.name === "pharos").map(({ name, status }) => ({ name, status })),
        tools: (e.tools ?? []).filter((t) => t.startsWith("mcp__pharos__")),
      });
    } else if (e.type === "assistant" || e.type === "user") {
      const content = (Array.isArray(e.message?.content) ? e.message.content : []).filter((b) =>
        ["text", "tool_use", "tool_result"].includes(b.type),
      );
      if (content.length) clean.push({ type: e.type, message: { role: e.message.role, content } });
    } else if (e.type === "result") {
      clean.push({
        type: "result",
        subtype: e.subtype,
        is_error: e.is_error,
        result: e.result,
        num_turns: e.num_turns,
        duration_ms: e.duration_ms,
        session_id: e.session_id,
      });
    }
  }
  writeFileSync(join(outDir, file), clean.map((c) => JSON.stringify(redactDeep(c))).join("\n") + "\n");
}
