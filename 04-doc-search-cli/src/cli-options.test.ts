// Command line, saved setting and the waiting line. No network.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseArgs } from "./args.js";
import { displayPath, loadSettings, saveSettings, settingsPath } from "./settings.js";
import { ASKING, pick, startSpinner } from "./spinner.js";

describe("command line", () => {
  it("takes a question without quotes", () => {
    const cmd = parseArgs(["how", "do", "I", "confirm", "a", "transaction", "from", "the", "cli?"]);
    assert.equal(cmd.kind, "ask");
    assert.equal(cmd.kind === "ask" && cmd.options.question, "how do I confirm a transaction from the cli?");
  });

  it("takes a quoted question the same way", () => {
    const cmd = parseArgs(["how do I confirm a transaction?", "--verify"]);
    assert.deepEqual(cmd.kind === "ask" && [cmd.options.question, cmd.options.verify], ["how do I confirm a transaction?", true]);
  });

  it("leaves --verify unset so the saved setting decides", () => {
    const cmd = parseArgs(["what", "is", "pharos"]);
    assert.equal(cmd.kind === "ask" && cmd.options.verify, undefined);
    assert.equal((parseArgs(["x", "--no-verify"]) as { options: { verify?: boolean } }).options.verify, false);
  });

  it("treats --verify-on / --verify-off as settings, in any letter case", () => {
    assert.deepEqual(parseArgs(["--verify-on"]), { kind: "settings", setVerify: true });
    assert.deepEqual(parseArgs(["--verifyON"]), { kind: "settings", setVerify: true });
    assert.deepEqual(parseArgs(["--verifyOFF"]), { kind: "settings", setVerify: false });
    assert.deepEqual(parseArgs(["--verify-status"]), { kind: "settings", setVerify: undefined });
  });

  it("can switch the setting and ask in one go", () => {
    const cmd = parseArgs(["--verify-on", "which", "EntryPoint", "is", "on", "mainnet?"]);
    assert.equal(cmd.kind, "ask");
    assert.equal(cmd.kind === "ask" && cmd.setVerify, true);
    assert.equal(cmd.kind === "ask" && cmd.options.question, "which EntryPoint is on mainnet?");
  });

  it("keeps words like 'verify on' inside a question", () => {
    const cmd = parseArgs(["verify", "on", "testnet?"]);
    assert.equal(cmd.kind === "ask" && cmd.options.question, "verify on testnet?");
    assert.equal(cmd.kind === "ask" && cmd.setVerify, undefined);
  });

  it("opens the one-question prompt when there is no question", () => {
    assert.equal(parseArgs([]).kind, "prompt");
    assert.equal(parseArgs(["--full"]).kind, "prompt");
  });

  it("has search, page, help and rejects unknown flags", () => {
    assert.deepEqual(parseArgs(["search", "x402", "fees"]), { kind: "search", words: "x402 fees" });
    assert.equal(parseArgs(["page", "https://docs.pharos.xyz/tooling-and-infrastructure/mcp"]).kind, "page");
    assert.throws(() => parseArgs(["page", "https://example.com"]), /docs\.pharos\.xyz/);
    assert.deepEqual(parseArgs(["--help"]), { kind: "help", code: 0 });
    assert.throws(() => parseArgs(["hi", "--verfy"]), /Unknown option --verfy/);
  });
});

describe("saved setting", () => {
  const dir = fileURLToPath(new URL("../.test-tmp/", import.meta.url));
  const file = join(dir, "config.json");

  it("defaults to off and remembers on/off", () => {
    rmSync(dir, { recursive: true, force: true });
    assert.equal(loadSettings(file).verify, false);
    saveSettings({ verify: true }, file);
    assert.equal(loadSettings(file).verify, true);
    saveSettings({ verify: false }, file);
    assert.equal(loadSettings(file).verify, false);
  });

  it("survives a broken file", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, "{not json");
    assert.equal(loadSettings(file).verify, false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows the home folder as ~ in messages", () => {
    assert.equal(displayPath("/home/me/.config/rtfm/config.json", "/home/me"), "~/.config/rtfm/config.json");
    assert.equal(displayPath("/opt/rtfm.json", "/home/me"), "/opt/rtfm.json");
    assert.equal(displayPath("demo/.rec/config.json", "/home/me"), "demo/.rec/config.json");
  });

  it("lives in the usual config folder, or wherever RTFM_CONFIG says", () => {
    assert.equal(settingsPath({ RTFM_CONFIG: "/tmp/x.json" }), "/tmp/x.json");
    assert.equal(settingsPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32"), join("C:\\Users\\me\\AppData\\Roaming", "rtfm", "config.json"));
    assert.equal(settingsPath({ XDG_CONFIG_HOME: "/home/me/.config" }, "linux"), join("/home/me/.config", "rtfm", "config.json"));
  });
});

describe("waiting line", () => {
  it("has a set of phrases and never repeats the same one twice in a row", () => {
    assert.ok(ASKING.length >= 10);
    for (let i = 0; i < 50; i++) {
      const r = i / 50;
      assert.notEqual(pick(ASKING, () => r, ASKING[0]), ASKING[0]);
    }
  });

  it("writes nothing when the output is not a terminal", () => {
    let written = "";
    const out = { isTTY: false, write: (s: string) => ((written += s), true) } as unknown as NodeJS.WriteStream;
    const s = startSpinner(ASKING, out, false);
    s.phase(ASKING);
    s.stop();
    assert.equal(written, "");
  });

  it("shows a phrase and the seconds, then clears the line", () => {
    let written = "";
    const out = { isTTY: true, write: (s: string) => ((written += s), true) } as unknown as NodeJS.WriteStream;
    const s = startSpinner(["Dusting off the manuals"], out, true);
    s.stop();
    assert.match(written, /Dusting off the manuals… 0s/);
    assert.ok(written.endsWith("\r\x1b[2K"));
  });
});
