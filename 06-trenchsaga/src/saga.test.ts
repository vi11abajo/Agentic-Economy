// The saga engine on a scripted fake chain: every failure mode the retry and rollback policy covers.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { Saga, newState, type Chain, type Fees, type Receipt, type SagaState, type Step, type TxSpec } from "./saga.js";
import { fromJson, parseEnv, toJson } from "./store.js";
import { revertReason } from "./chain.js";
import { encodeErrorResult, parseAbi } from "viem";

type Outcome = "ok" | "revert" | "timeout" | "refuse" | "late"; // late: not mined in time, but mined on the next check

/** A chain whose sends follow a script per step name. simOk decides what a fresh simulation says. */
class FakeChain implements Chain {
  readonly account = "0x000000000000000000000000000000000000dEaD" as const;
  sent: { step: string; nonce: number; fees: Fees; hash: Hex }[] = [];
  simulated: string[] = [];
  private receipts = new Map<Hex, { r: Receipt; visibleAfter: number }>();
  private nonce = 7;
  private checks = new Map<Hex, number>();
  constructor(private script: Record<string, Outcome[]>, public simOk: (step: string, n: number) => boolean = () => true) {}
  private stepOf(tx: TxSpec) {
    return tx.data.slice(2);
  }
  async simulate(tx: TxSpec) {
    const step = this.stepOf(tx);
    this.simulated.push(step);
    const n = this.simulated.filter((s) => s === step).length;
    return this.simOk(step, n) ? ({ ok: true } as const) : ({ ok: false, reason: `${step}: execution reverted` } as const);
  }
  async send(tx: TxSpec, nonce: number, fees: Fees): Promise<Hex> {
    const step = this.stepOf(tx);
    const outcome = (this.script[step] ?? []).shift() ?? "ok";
    if (outcome === "refuse") throw new Error("transaction underpriced: fee cap below block base fee");
    const hash = `0x${(this.sent.length + 1).toString(16).padStart(64, "0")}` as Hex;
    this.sent.push({ step, nonce, fees, hash });
    if (nonce === this.nonce) this.nonce++;
    const r: Receipt = { hash, status: outcome === "revert" ? "reverted" : "success", block: 100n + BigInt(this.sent.length), logs: [], gasUsed: 21000n, effectiveGasPrice: 10n };
    if (outcome !== "timeout") this.receipts.set(hash, { r, visibleAfter: outcome === "late" ? 1 : 0 });
    return hash;
  }
  readFailures = 0;
  async waitReceipt(hash: Hex) {
    if (this.readFailures > 0) {
      this.readFailures--;
      throw new Error("cu limit exceeded; Request too fast per second");
    }
    const x = this.receipts.get(hash);
    if (!x) return null;
    const seen = this.checks.get(hash) ?? 0;
    this.checks.set(hash, seen + 1);
    return seen >= x.visibleAfter ? x.r : null;
  }
  async pendingNonce() {
    return this.nonce;
  }
  async baseFee() {
    return 10_000_000_000n;
  }
}

interface Ctx {
  done: string[];
  undone: string[];
}

function step(name: string, opts: { undo?: boolean; badVerify?: boolean } = {}): Step<Ctx> {
  return {
    name,
    title: `step ${name}`,
    plan: async () => ({ to: "0x0000000000000000000000000000000000000001", data: `0x${name}` as Hex }),
    verify: async (c) => {
      if (opts.badVerify) throw new Error("balance didn't move");
      c.done.push(name);
      return `${name} ok`;
    },
    compensate: opts.undo === false ? [] : [{
      name: "undo",
      plan: async () => ({ to: "0x0000000000000000000000000000000000000001", data: `0x${name}u` as Hex }),
      verify: async (c) => {
        c.undone.push(name);
        return `${name} undone`;
      },
    }],
    noCompensationBecause: opts.undo === false ? "nothing to give back" : undefined,
  };
}

function run(steps: Step<Ctx>[], chain: FakeChain, faults = {}, state?: SagaState<Ctx>) {
  const events: Record<string, unknown>[] = [];
  const saves: string[] = [];
  const s = state ?? newState<Ctx>("t", "test", steps, { done: [], undone: [] });
  const saga = new Saga(steps, s, chain, { maxAttempts: 3, receiptTimeoutMs: 1, feeMultiplier: 2n }, faults, (e) => events.push(e), (st) => saves.push(st.status));
  return { saga, events, saves, state: s };
}
const ev = (events: Record<string, unknown>[]) => events.map((e) => `${e.step}:${e.event}`);

// Steps are named with hex letters (a, b, c, d) because the fake chain carries the name in the calldata.
describe("a saga that goes through", () => {
  it("runs every step in order, each verified before the next starts", async () => {
    const chain = new FakeChain({});
    const { saga, events, state } = run([step("a"), step("b"), step("c")], chain);
    assert.equal(await saga.run(), "done");
    assert.deepEqual(state.ctx.done, ["a", "b", "c"]);
    assert.deepEqual(chain.sent.map((x) => x.nonce), [7, 8, 9]);
    const e = ev(events);
    assert.ok(e.indexOf("a:verified") < e.indexOf("b:start"), "b starts only after a is verified");
    assert.ok(e.indexOf("b:verified") < e.indexOf("c:start"));
    assert.equal(e.at(-1), "-:saga done");
  });

  it("writes the state after every transition, so the file always shows the current step", async () => {
    const { saga, events, saves } = run([step("a"), step("b")], new FakeChain({}));
    await saga.run();
    assert.equal(saves.length, events.length);
  });
});

describe("retry policy: transient failures", () => {
  it("replaces a transaction that isn't mined in time: same nonce, higher fee", async () => {
    const chain = new FakeChain({ b: ["timeout", "ok"] });
    const { saga, events } = run([step("a"), step("b")], chain);
    assert.equal(await saga.run(), "done");
    const b = chain.sent.filter((x) => x.step === "b");
    assert.equal(b.length, 2);
    assert.equal(b[0].nonce, b[1].nonce, "replacement keeps the nonce");
    assert.ok(b[1].fees.maxFeePerGas > b[0].fees.maxFeePerGas && b[1].fees.maxPriorityFeePerGas > b[0].fees.maxPriorityFeePerGas, "and pays more");
    assert.ok(ev(events).includes("b:not mined in time, will replace"));
  });

  it("an underpriced send the node refuses is sent again at a fair fee", async () => {
    const chain = new FakeChain({ b: ["refuse", "ok"] });
    const { saga, events } = run([step("a"), step("b")], chain, { dropAt: "b" });
    assert.equal(await saga.run(), "done");
    assert.ok(ev(events).includes("b:node refused the transaction"));
    const sending = events.filter((e) => e.step === "b" && e.event === "sending");
    assert.equal(sending[0].underpriced, true);
    assert.equal(sending[0].maxFeeGwei, 1);
    assert.equal(sending[1].maxFeeGwei, 30, "base 10 gwei x 2, plus one base for the second attempt");
  });

  it("a revert is retried when the step simulates fine on fresh state (the state moved, not the step)", async () => {
    const chain = new FakeChain({ b: ["revert", "ok"] });
    const { saga, events } = run([step("a"), step("b")], chain);
    assert.equal(await saga.run(), "done");
    assert.ok(ev(events).includes("b:reverted"));
    assert.ok(ev(events).includes("b:simulation passes on fresh state, retrying"));
  });

  it("never runs a step twice when a stuck transaction lands after all", async () => {
    const chain = new FakeChain({ b: ["late"] });
    const { saga, state } = run([step("a"), step("b")], chain);
    assert.equal(await saga.run(), "done");
    assert.equal(chain.sent.filter((x) => x.step === "b").length, 1, "found the late receipt instead of replacing");
    assert.deepEqual(state.ctx.done, ["a", "b"]);
  });

  it("a failed chain read while waiting is not a failed step: it checks again, without sending twice", async () => {
    const chain = new FakeChain({});
    chain.readFailures = 1; // the RPC refuses the first receipt read (seen live on Pharos: "Request too fast")
    const { saga, events, state } = run([step("a"), step("b")], chain);
    assert.equal(await saga.run(), "done");
    assert.equal(chain.sent.length, 2, "one transaction per step");
    assert.ok(ev(events).includes("a:chain read failed, checking again"));
    assert.deepEqual(state.ctx.done, ["a", "b"]);
  });

  it("gives up after maxAttempts", async () => {
    const chain = new FakeChain({ b: ["timeout", "timeout", "timeout"] });
    const { saga, state } = run([step("a"), step("b")], chain);
    assert.equal(await saga.run(), "compensated");
    assert.match(state.error!, /gave up after 3 attempts/);
  });
});

describe("rollback: permanent failures", () => {
  it("undoes the done steps in reverse order when a step can't succeed on fresh state", async () => {
    const chain = new FakeChain({ c: ["revert"] }, (s, n) => !(s === "c" && n > 1));
    const { saga, events, state } = run([step("a"), step("b"), step("c")], chain);
    assert.equal(await saga.run(), "compensated");
    assert.deepEqual(state.ctx.undone, ["b", "a"], "b is undone first, then a");
    assert.deepEqual(state.steps.map((s) => s.state), ["compensated", "compensated", "failed"]);
    assert.ok(ev(events).includes("c:simulation fails on fresh state"));
  });

  it("a step with nothing to undo says why", async () => {
    const chain = new FakeChain({}, (s) => s !== "c");
    const { saga, events, state } = run([step("a"), step("b", { undo: false }), step("c")], chain);
    assert.equal(await saga.run(), "compensated");
    assert.deepEqual(state.ctx.undone, ["a"]);
    assert.equal(events.find((e) => e.event === "nothing to undo")?.because, "nothing to give back");
  });

  it("the demo failure is a real revert: sent without simulating, then judged on fresh state", async () => {
    const chain = new FakeChain({ c: ["revert"] }, (s) => s !== "c");
    const { saga, events, state } = run([step("a"), step("b"), step("c")], chain, { failAt: "c" });
    assert.equal(await saga.run(), "compensated");
    assert.equal(chain.sent.filter((x) => x.step === "c").length, 1, "the sabotaged attempt reached the chain");
    assert.equal(events.find((e) => e.step === "c" && e.event === "sending")?.sabotage, true);
    assert.deepEqual(state.ctx.undone, ["b", "a"]);
  });

  it("a receipt that doesn't show the expected result is a permanent failure", async () => {
    const { saga, state } = run([step("a"), step("b", { badVerify: true })], new FakeChain({}));
    assert.equal(await saga.run(), "compensated");
    assert.match(state.error!, /receipt doesn't show the expected result: balance didn't move/);
  });

  it("stops as stuck when an undo itself can't be done, and says which one", async () => {
    const chain = new FakeChain({}, (s) => s !== "c" && s !== "au");
    const { saga, state } = run([step("a"), step("b"), step("c")], chain);
    assert.equal(await saga.run(), "stuck");
    assert.match(state.stuck!, /compensation a\/undo/);
    assert.deepEqual(state.ctx.undone, ["b"]);
  });
});

describe("resume after a crash", () => {
  it("picks up a sent transaction from the saved state instead of sending it again", async () => {
    const chain = new FakeChain({});
    const steps = [step("a"), step("b")];
    // The program died right after sending b: the state file has a pending hash for it.
    const hash = await chain.send({ to: "0x0000000000000000000000000000000000000001", data: "0xb" }, 7, { maxFeePerGas: 1n, maxPriorityFeePerGas: 0n });
    const saved = newState<Ctx>("t", "test", steps, { done: ["a"], undone: [] });
    saved.steps[0].state = "verified";
    saved.steps[1].state = "pending";
    saved.steps[1].pending = { nonce: 7, hashes: [hash] };
    const restored = fromJson<SagaState<Ctx>>(toJson(saved));
    const { saga, state } = run(steps, chain, {}, restored);
    assert.equal(await saga.run(), "done");
    assert.equal(chain.sent.length, 1, "nothing new was sent");
    assert.deepEqual(state.ctx.done, ["a", "b"]);
  });

  it("keeps bigints exact in the state file", () => {
    const back = fromJson<{ v: bigint }>(toJson({ v: 123456789012345678901234567890n }));
    assert.equal(back.v, 123456789012345678901234567890n);
  });
});

describe("the key", () => {
  it("is read from .env and only the address comes out", () => {
    const pk = generatePrivateKey();
    const env = parseEnv(`# trenchsaga\nPRIVATE_KEY=${pk}\n`);
    assert.equal(privateKeyToAccount(env.PRIVATE_KEY as Hex).address.length, 42);
  });
});

describe("revert reasons", () => {
  it("names Prosper's Slippage() from the data of a real reverted buy (tx 0x8a8b…96f9)", () => {
    const err = { message: "Execution reverted", cause: { message: "RPC Request failed", data: "0x7dd37f70" } };
    assert.equal(revertReason(err), "Slippage(): the curve would give less than minOut");
  });

  it("decodes Error(string) and shows unknown selectors as they are", () => {
    const data = encodeErrorResult({ abi: parseAbi(["error Error(string)"]), errorName: "Error", args: ["too late"] });
    assert.equal(revertReason({ cause: { data } }), 'Error("too late")');
    assert.equal(revertReason({ cause: { data: "0xdeadbeef" } }), "custom error 0xdeadbeef");
  });
});
