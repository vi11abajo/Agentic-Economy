import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { homeDir, loadAccount, parseEnv } from "./store.js";

const KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const fresh = () => mkdtempSync(join(tmpdir(), "onego-"));

describe("store", () => {
  it("lets ONEGO_HOME decide where things live", () => {
    assert.equal(homeDir({ ONEGO_HOME: "D:/x" }, "win32"), "D:/x");
    assert.equal(homeDir({ APPDATA: "C:/Users/me/AppData/Roaming" }, "win32"), join("C:/Users/me/AppData/Roaming", "onego"));
  });

  it("has no account without a .env", () => {
    assert.equal(loadAccount(fresh()), null);
  });

  it("reads the key from .env, quotes and comments allowed", () => {
    const home = fresh();
    writeFileSync(join(home, ".env"), `# my test wallet\nPRIVATE_KEY="${KEY}"\n`);
    assert.equal(loadAccount(home)?.address, "0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    assert.deepEqual(parseEnv("A=1\n#B=2\nexport C='3'"), { A: "1", C: "3" });
  });

  it("never repeats a broken key back in its error", () => {
    const home = fresh();
    writeFileSync(join(home, ".env"), "PRIVATE_KEY=0xdeadbeefdeadbeefnotakey\n");
    assert.throws(() => loadAccount(home), (err: Error) => !err.message.includes("deadbeef") && /PRIVATE_KEY/.test(err.message));
  });
});
