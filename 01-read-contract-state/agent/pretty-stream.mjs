// Live, human-readable view of a Claude Code stream-json run (stdin -> terminal):
// MCP connection, each Pharos MCP tool call with its arguments, each result, the agent's answer,
// and a waiting timer while the agent thinks. Raw lines are also saved to the file given as argv[2],
// and timestamped events are appended to argv[3] (used to edit the screen recording).
// Usage: claude -p "..." --output-format stream-json --verbose | node pretty-stream.mjs raw.jsonl events.log
import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const [rawFile, eventsFile] = process.argv.slice(2);
if (rawFile) writeFileSync(rawFile, "");
const COBALT = "\x1b[38;2;30;43;250m";
const MUTED = "\x1b[38;2;107;107;107m";
const GREEN = "\x1b[38;2;5;150;105m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const WIDTH = Math.max(60, (process.stdout.columns || 92) - 4);

const started = Date.now();
let waitingSince = Date.now();
let spinnerOn = false;

function event(kind) {
  if (eventsFile) appendFileSync(eventsFile, `${Date.now()} ${kind}\n`);
}
function clearSpinner() {
  if (spinnerOn) process.stdout.write("\r\x1b[2K");
  spinnerOn = false;
}
function println(text = "") {
  clearSpinner();
  process.stdout.write(`${text}\n`);
  waitingSince = Date.now();
}
function wrap(text, indent) {
  const out = [];
  for (const para of String(text).split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      if ((line + " " + word).trim().length > WIDTH - indent.length) {
        out.push(indent + line.trim());
        line = word;
      } else line += " " + word;
    }
    out.push(indent + line.trim());
  }
  return out.join("\n");
}
function short(value, max = 160) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

const spinner = setInterval(() => {
  const secs = ((Date.now() - waitingSince) / 1000).toFixed(0);
  if (Date.now() - waitingSince < 700) return;
  process.stdout.write(`\r\x1b[2K${MUTED}  ⋯ agent is thinking · ${secs}s${RESET}`);
  spinnerOn = true;
}, 250);

// Local absolute paths (Windows or MSYS style) are shown as ./<name>.
function redact(text) {
  return String(text)
    .replace(/(^|[\s"'=])[A-Za-z]:[\\/][^\s"'`]*[\\/]([^\\/\s"'`]+)/g, "$1./$2")
    .replace(/(^|\s)\/[a-z]\/[^\s"'`]*\/([^/\s"'`]+)/g, "$1./$2");
}

// Terminal-friendly text: drop Markdown emphasis/code marks, turn table rows into "a: b" lines.
function plain(md) {
  return md
    .split("\n")
    .filter((l) => !/^\s*\|?\s*:?-{3,}/.test(l))
    .map((l) => (/^\s*\|.*\|\s*$/.test(l) ? l.trim().slice(1, -1).split("|").map((c) => c.trim()).join(": ") : l))
    .filter((l) => l !== "Field: Value")
    .filter((l) => !/^\s*`{2,}/.test(l))
    .join("\n")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#+\s*/gm, "");
}

const toolNames = new Map();
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  if (rawFile) appendFileSync(rawFile, `${line}\n`);
  let e;
  try {
    e = JSON.parse(line);
  } catch {
    return;
  }
  if (e.type === "system" && e.subtype === "init") {
    println(`${COBALT}${BOLD}Claude ›${RESET}`);
    event("init");
    return;
  }
  const content = Array.isArray(e.message?.content) ? e.message.content : [];
  for (const b of content) {
    if (e.type === "assistant" && b.type === "tool_use") {
      toolNames.set(b.id, b.name);
      if (b.name === "Bash") {
        println(`${MUTED}  ↳ runs ${RESET}${COBALT}${redact(b.input?.command ?? "")}${RESET}`);
        event("call bash");
      } else if (b.name.startsWith("mcp__")) {
        const name = b.name.replace("mcp__pharos__", "");
        println(`${MUTED}  ↳ Pharos MCP · ${RESET}${COBALT}${name}${RESET}${MUTED} ${short(b.input, 170)}${RESET}`);
        event(`call ${name}`);
      } // ToolSearch = Claude Code loading tool schemas: not shown
    } else if (e.type === "user" && b.type === "tool_result") {
      const name = toolNames.get(b.tool_use_id) ?? "";
      if (name !== "Bash" && !name.startsWith("mcp__")) continue;
      const text = Array.isArray(b.content) ? b.content.map((c) => c.text ?? "").join(" ") : String(b.content ?? "");
      println(`${MUTED}    = ${short(redact(text).replace(/\s+/g, " "), 170)}${RESET}`);
      event("result");
    } else if (e.type === "assistant" && b.type === "text" && b.text.trim()) {
      println(wrap(redact(plain(b.text.trim())), "  "));
      event("answer");
    }
  }
  if (e.type === "result") {
    clearInterval(spinner);
    event("done");
  }
});
rl.on("close", () => {
  clearInterval(spinner);
  clearSpinner();
});
