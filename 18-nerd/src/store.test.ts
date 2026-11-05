import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_SHELF_LIFE_MS, docsFirstProblem, loadBrief, saveBrief } from "./store.js";

test("the chain step is refused until the docs were read, and again once that reading goes stale", () => {
  assert.match(docsFirstProblem(undefined) ?? "", /run `nerd docs`/);
  const brief = { key: "k", subject: "s", searched: [], pages: [], quotes: [], madeAt: 1_000 };
  assert.equal(docsFirstProblem(brief, 1_000 + BRIEF_SHELF_LIFE_MS - 1), undefined);
  assert.match(docsFirstProblem(brief, 1_000 + BRIEF_SHELF_LIFE_MS + 1) ?? "", /older than an hour/);
});

test("a brief saved under a key comes back whole", () => {
  process.env.NERD_HOME = mkdtempSync(join(tmpdir(), "nerd-"));
  const brief = { key: "fn-0xc879c018-name", subject: "s", searched: ["q"], pages: [], quotes: [], madeAt: 5 };
  saveBrief(brief);
  assert.deepEqual(loadBrief(brief.key), brief);
  assert.equal(loadBrief("never-read"), undefined);
});
