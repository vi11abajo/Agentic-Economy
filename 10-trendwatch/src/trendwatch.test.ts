// Tests of the rules on fixed price series, of the store across "crashes", and of whole runs with a fake source.
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { main } from "./cli.js";
import { atr, checkRule, DEFAULT_RULE, ema, evaluate, type Rule } from "./rules.js";
import { padKey, type Observation, type Source } from "./sources.js";
import { KeyedLog, lock } from "./store.js";

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 15);
/** One observation per hour from a list of closes. */
const series = (closes: number[]): Observation[] => closes.map((c, i) => ({ key: padKey(T0 + i * H), t: T0 + (i + 1) * H, close: c }));
const rule = (r: Partial<Rule> = {}): Rule => ({ ...DEFAULT_RULE, ...r });
/** 32 calm observations ending on a small rise (100.1), so ATR is known before the part a test is about. */
const calm = () => Array.from({ length: 32 }, (_, i) => 100 + (i % 2 ? 0.1 : -0.1));

describe("indicators", () => {
  it("EMA starts from the SMA of the first period, then k = 2/(period+1)", () => {
    const e = ema([1, 2, 3, 4], 3);
    assert.equal(e[1], undefined);
    assert.equal(e[2], 2);
    assert.equal(e[3], 4 * 0.5 + 2 * 0.5);
  });

  it("ATR is the plain average of the true ranges, or of the absolute changes without high/low", () => {
    const a = atr([{ close: 1 }, { close: 3 }, { close: 2 }, { close: 2.5 }], 3);
    assert.equal(a[3], (2 + 1 + 0.5) / 3);
    const b = atr([{ close: 10, high: 10, low: 10 }, { close: 11, high: 12, low: 9 }], 1);
    assert.equal(b[1], 3);
  });
});

describe("the trend rule", () => {
  it("won't take fewer than 3 observations", () => {
    assert.match(checkRule(rule({ n: 2 })).join(), /3 or more/);
    assert.deepEqual(checkRule(rule({ n: 3 })), []);
  });

  it("confirms after n lower closes in a row, once, at that exact observation", () => {
    const rows = evaluate(series([...calm(), 100.0, 99.9, 99.8, 99.7, 99.75, 99.6, 99.5, 99.4]), rule());
    const fired = rows.flatMap((r, i) => (r.trigger ? [i] : []));
    assert.deepEqual(fired, [34, 39]); // the 3rd lower close; again only after the streak broke at 36
  });

  it("is configurable: direction, n and a minimum total move", () => {
    const up = evaluate(series([...calm(), 100.2, 100.3, 100.4]), rule({ direction: "up", n: 4 }));
    assert.equal(up.findIndex((r) => r.trigger), 34); // the calm part's last rise is the first of the four
    const small = evaluate(series([...calm(), 100.05, 100.0, 99.95]), rule({ min_move_pct: 1 }));
    assert.equal(small.some((r) => r.trigger), false);
  });

  it("a single spike doesn't trigger: the move back makes it count for nothing", () => {
    // Two lower closes, then a drop of ~10 ATR that would be the third, then most of it comes back.
    const rows = evaluate(series([...calm(), 100.0, 99.9, 97.5, 99.8]), rule());
    assert.equal(rows.some((r) => r.trigger), false);
    assert.equal(rows[34].mark, "spike ignored");
    assert.equal(rows[34].streak, 2);
  });

  it("a spike that holds counts, one observation later", () => {
    const rows = evaluate(series([...calm(), 100.0, 99.9, 97.5, 97.4]), rule());
    assert.equal(rows[34].mark, "spike confirmed");
    assert.equal(rows.findIndex((r) => r.trigger), 35);
  });

  it("a spike that completes the streak and holds confirms the trend on the next observation, even if that one ticks up", () => {
    const rows = evaluate(series([...calm(), 100.0, 99.9, 97.5, 97.6]), rule());
    assert.equal(rows[34].mark, "spike confirmed");
    assert.equal(rows[35].trigger, true);
    assert.equal(rows[35].mark, "against");
    assert.match(rows[35].detail!, /previous observation held/);
  });

  it("the EMA rule needs every timeframe below a falling EMA, n times in a row", () => {
    const down = Array.from({ length: 40 }, (_, i) => 100 - i * 0.5);
    const rows = evaluate(series(down), rule({ type: "ema" }));
    assert.equal(rows.findIndex((r) => r.trigger), 32); // EMA known from the 30th close and the 31st (slope)
    const flat = evaluate(series(Array.from({ length: 40 }, () => 100)), rule({ type: "ema" }));
    assert.equal(flat.some((r) => r.trigger), false);
  });
});

describe("the store", () => {
  it("never writes a key twice, and drops a line cut off by a crash", () => {
    const home = mkdtempSync(join(tmpdir(), "tw-"));
    const log = new KeyedLog<{ key: string; v: number }>(home, "w", "x.jsonl");
    assert.equal(log.add([{ key: "1", v: 1 }, { key: "2", v: 2 }]), 2);
    assert.equal(log.add([{ key: "2", v: 9 }, { key: "3", v: 3 }]), 1);
    const f = join(home, "watches", "w", "x.jsonl");
    appendFileSync(f, '{"key":"4","v":'); // the process died mid-write
    const again = new KeyedLog<{ key: string; v: number }>(home, "w", "x.jsonl");
    assert.equal(again.repaired, true);
    assert.deepEqual(again.all().map((x) => x.key), ["1", "2", "3"]);
    assert.ok(readFileSync(f, "utf8").endsWith("\n"));
  });

  it("lets one run at a time", () => {
    const home = mkdtempSync(join(tmpdir(), "tw-"));
    const release = lock(home);
    assert.throws(() => lock(home), /another trendwatch run/);
    release();
    lock(home)();
  });
});

describe("runs", () => {
  /** A source that only has what the test has "published" so far. */
  function fake(closes: number[]) {
    const published = { n: 0 };
    const all = series(closes);
    const src: Source = { fetch: async (after) => all.slice(0, published.n).filter((o) => !after || o.key > after) };
    return { published, src, now: () => (published.n ? all[published.n - 1].t : T0) };
  }

  function setup(closes: number[]) {
    const home = mkdtempSync(join(tmpdir(), "tw-"));
    const f = fake(closes);
    const lines: string[] = [];
    const hooks: Record<string, string>[] = [];
    const deps = { home, source: () => f.src, out: (s: string) => lines.push(s), now: f.now, run: (_c: string, env: Record<string, string>) => (hooks.push(env), 0) };
    return { home, f, lines, hooks, deps };
  }

  it("keeps the history across restarts: nothing lost, nothing twice, one signal", async () => {
    const closes = [...calm(), 100.0, 99.9, 99.8, 99.7];
    const t = setup(closes);
    t.f.published.n = 33;
    assert.equal(await main(["add", "p", "okx:PROS-USDT", "--bar", "1H", "--since", "2026-10-15", "--on-trigger", "echo hi"], t.deps), 0);
    // "Restart": a new process runs observe twice while more observations arrive.
    t.f.published.n = 35;
    assert.equal(await main(["observe"], t.deps), 0);
    assert.equal(await main(["observe"], t.deps), 0);
    t.f.published.n = 36;
    assert.equal(await main(["observe"], t.deps), 0);
    const stored = readFileSync(join(t.home, "watches", "p", "observations.jsonl"), "utf8").trim().split("\n");
    assert.equal(stored.length, 36);
    assert.equal(new Set(stored.map((l) => JSON.parse(l).key)).size, 36);
    const sigs = readFileSync(join(t.home, "watches", "p", "signals.jsonl"), "utf8").trim().split("\n");
    assert.equal(sigs.length, 1);
    assert.equal(t.hooks.length, 1);
    assert.equal(t.hooks[0].TRENDWATCH_CLOSE, "99.8");
  });

  it("history shows every observation and the exact moment the trend was confirmed", async () => {
    const t = setup([...calm(), 100.0, 99.9, 99.8]);
    t.f.published.n = 35;
    await main(["add", "p", "okx:PROS-USDT", "--bar", "1H", "--since", "2026-10-15"], t.deps);
    t.lines.length = 0;
    assert.equal(await main(["history", "p", "--all"], t.deps), 0);
    const out = t.lines.join("\n");
    assert.match(out, /stored: 35 observations/);
    assert.match(out, /2026-10-16 11:00 UTC\s+99\.8000\s+-0\.10%\s+3\/3\s+counts {2}<== TREND CONFIRMED/);
    assert.match(out, /signals:\n {2}2026-10-16 11:00 UTC {2}close 99\.8000/);
  });

  it("rejects a rule with fewer than 3 observations", async () => {
    const t = setup([100]);
    assert.equal(await main(["add", "p", "okx:PROS-USDT", "--n", "2"], t.deps), 2);
  });
});
