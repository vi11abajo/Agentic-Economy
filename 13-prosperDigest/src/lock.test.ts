import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { acquireLock, releaseLock } from "./lock.js";

describe("lock", () => {
  it("only one holder at a time, even within the same process", () => {
    const h = mkdtempSync(join(tmpdir(), "pd-"));
    assert.equal(acquireLock(h), true);
    assert.equal(acquireLock(h), false, "a second start right after must not get it");
    releaseLock(h);
    assert.equal(acquireLock(h), true);
  });

  it("takes over a lock left by a dead process", () => {
    const h = mkdtempSync(join(tmpdir(), "pd-"));
    writeFileSync(join(h, "scan.lock"), "999999999");
    assert.equal(acquireLock(h), true);
  });
});
