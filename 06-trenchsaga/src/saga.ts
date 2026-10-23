// The saga engine. A saga is a list of dependent steps; each step builds its transaction from fresh chain
// state, sends it, waits for the receipt and verifies the result before the next step may start. When a step
// can't be completed, the steps already done are undone in reverse order by their compensations.
//
// Retry policy. A failed attempt is not judged by its error type: a revert can be caused by the state moving
// between signing and inclusion (someone traded first, the deadline passed), and that goes away on its own.
// So after every failed attempt the step is rebuilt on fresh state and simulated again:
//   - the simulation passes  -> transient: send again (up to maxAttempts)
//   - the simulation fails   -> permanent: stop and compensate
// A transaction that isn't mined in time is replaced with the same nonce and a higher fee (a dropped or
// underpriced transaction), and one the node refuses to accept is resent with a fair fee.
//
// Every transition is written to the journal before the engine moves on, so the state on disk always says
// exactly which step the saga is in, and an interrupted saga can be resumed from there.
import type { Address, Hex, Log } from "viem";

export interface TxSpec {
  to: Address;
  data: Hex;
  value?: bigint;
  /** Fixed gas limit. Needed when the call is expected to revert, since estimation would fail first. */
  gas?: bigint;
}

export interface Receipt {
  hash: Hex;
  status: "success" | "reverted";
  block: bigint;
  logs: Log[];
  gasUsed: bigint;
  effectiveGasPrice: bigint;
}

export interface Fees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/** Everything the engine needs from the chain. The real one talks to Pharos, the tests use a fake. */
export interface Chain {
  readonly account: Address;
  simulate(tx: TxSpec): Promise<{ ok: true } | { ok: false; reason: string }>;
  send(tx: TxSpec, nonce: number, fees: Fees): Promise<Hex>;
  /** null when the transaction wasn't mined within timeoutMs. */
  waitReceipt(hash: Hex, timeoutMs: number): Promise<Receipt | null>;
  pendingNonce(): Promise<number>;
  baseFee(): Promise<bigint>;
  /** Why a mined transaction reverted (decoded custom error), when the chain can tell. */
  whyReverted?(hash: Hex): Promise<string>;
}

export interface Action<C> {
  name: string;
  /** Builds the transaction from the current state, or returns null when there is nothing to do. */
  plan(ctx: C, chain: Chain, opts: { sabotage: boolean }): Promise<TxSpec | null>;
  /** Checks the result on chain (receipt events and balances), records what it needs in ctx, and returns a
   *  one-line summary. Throws when the chain doesn't show what the step was supposed to do. */
  verify(ctx: C, chain: Chain, receipt: Receipt | null): Promise<string>;
}

export interface Step<C> extends Action<C> {
  title: string;
  /** Undo actions, run in order when a later step fails permanently. Empty: nothing to undo. */
  compensate: Action<C>[];
  /** Why this step needs no compensation (shown in the log). */
  noCompensationBecause?: string;
}

export interface Policy {
  maxAttempts: number;
  receiptTimeoutMs: number;
  /** Fee for a normal send: base fee times this. */
  feeMultiplier: bigint;
}

/** Demo switches. failAt makes a step fail for real; dropAt sends its first attempt underpriced. */
export interface Faults {
  failAt?: string;
  dropAt?: string;
}

export type StepState =
  | "pending"
  | "running"
  | "skipped"
  | "verified"
  | "failed"
  | "compensating"
  | "compensated";

export interface SagaState<C> {
  id: string;
  kind: string;
  status: "running" | "done" | "compensating" | "compensated" | "stuck";
  steps: { name: string; title: string; state: StepState; summary?: string; txs: string[]; pending?: Pending }[];
  ctx: C;
  /** Why the saga stopped going forward. */
  error?: string;
  /** Why the rollback itself stopped (status stuck); cleared when a resume finishes it. */
  stuck?: string;
}

/** Transactions sent for one nonce that haven't produced a receipt yet (the original and its replacements). */
export interface Pending {
  nonce: number;
  hashes: Hex[];
}

export type Journal = (event: Record<string, unknown>) => void;

export class PermanentFailure extends Error {}

const UNDERPRICED = 1_000_000_000n; // 1 gwei: under Pharos' 10 gwei base fee

export class Saga<C> {
  constructor(
    private steps: Step<C>[],
    public state: SagaState<C>,
    private chain: Chain,
    private policy: Policy,
    private faults: Faults,
    private journal: Journal,
    private save: (s: SagaState<C>) => void,
  ) {}

  private log(step: string, event: string, extra: Record<string, unknown> = {}) {
    this.journal({ saga: this.state.id, step, event, ...extra });
    this.save(this.state);
  }

  /** Runs (or resumes) the saga. Returns the final status. */
  async run(): Promise<SagaState<C>["status"]> {
    if (this.state.status === "running") {
      for (let i = 0; i < this.steps.length; i++) {
        const st = this.state.steps[i];
        if (st.state === "verified" || st.state === "skipped") continue;
        try {
          st.state = "running";
          this.log(st.name, "start", { title: st.title });
          const summary = await this.execute(this.steps[i], st);
          st.summary = summary ?? undefined;
          st.state = summary === null ? "skipped" : "verified";
          this.log(st.name, st.state, { summary: st.summary });
        } catch (e) {
          st.state = "failed";
          this.state.error = `${st.name}: ${(e as Error).message}`;
          this.state.status = "compensating";
          this.log(st.name, "failed", { error: (e as Error).message, permanent: e instanceof PermanentFailure });
          break;
        }
      }
      if (this.state.status === "running") {
        this.state.status = "done";
        this.log("-", "saga done");
        return "done";
      }
    }
    if (this.state.status === "compensating") await this.compensate();
    return this.state.status;
  }

  private async compensate() {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      const step = this.steps[i];
      const st = this.state.steps[i];
      if (st.state !== "verified" && st.state !== "compensating") continue;
      if (step.compensate.length === 0) {
        this.log(st.name, "nothing to undo", { because: step.noCompensationBecause ?? "" });
        st.state = "compensated";
        continue;
      }
      st.state = "compensating";
      this.log(st.name, "compensating");
      for (const action of step.compensate) {
        const rec: { name: string; txs: string[]; pending?: Pending } = { name: `${st.name}/${action.name}`, txs: st.txs };
        try {
          const summary = await this.execute({ ...action, title: action.name, compensate: [] }, rec as never);
          this.log(rec.name, summary === null ? "skipped" : "verified", { summary });
        } catch (e) {
          this.state.status = "stuck";
          this.state.stuck = `compensation ${rec.name}: ${(e as Error).message}`;
          this.log(rec.name, "compensation failed", { error: (e as Error).message });
          return;
        }
      }
      st.state = "compensated";
      this.log(st.name, "compensated");
    }
    this.state.status = "compensated";
    this.state.stuck = undefined;
    this.log("-", "saga compensated");
  }

  /** One step (or compensation action) with the retry policy. Returns the summary, or null if skipped. */
  private async execute(step: Step<C>, rec: { name: string; txs: string[]; pending?: Pending }): Promise<string | null> {
    const sabotage = this.faults.failAt === step.name;
    let replaceNonce: number | undefined;
    let readErrors = 0;
    for (let attempt = 1; ; attempt++) {
      try {
        const done = await this.attempt(step, rec, attempt, sabotage, replaceNonce);
        if (done.kind === "finished") return done.summary;
        replaceNonce = done.replaceNonce;
      } catch (e) {
        if (e instanceof PermanentFailure) throw e;
        // Reading the chain failed (RPC limit, dropped connection): that says nothing about the step itself.
        // Whatever was sent stays in rec.pending and is checked first on the next round, so nothing is sent twice.
        const reason = (e as Error).message.split("\n")[0].slice(0, 120);
        if (++readErrors > 5) throw new PermanentFailure(`the chain can't be read: ${reason}`);
        this.log(rec.name, "chain read failed, checking again", { reason });
        await new Promise((r) => setTimeout(r, 2_000));
        attempt--; // not a new attempt
      }
    }
  }

  private async attempt(
    step: Step<C>,
    rec: { name: string; txs: string[]; pending?: Pending },
    attempt: number,
    sabotage: boolean,
    replaceNonceIn: number | undefined,
  ): Promise<{ kind: "finished"; summary: string | null } | { kind: "again"; replaceNonce?: number }> {
    let replaceNonce = replaceNonceIn;
    {
      // A transaction from an earlier attempt (or an earlier run of the program) may still land: check it first.
      if (rec.pending) {
        let r: Receipt | null = null;
        for (const h of rec.pending.hashes) if (!r) r = await this.chain.waitReceipt(h, 1_500);
        if (r) {
          replaceNonce = undefined; // that nonce is used now
          const outcome = await this.settle(step, rec, r);
          if (outcome !== "retry") return { kind: "finished", summary: outcome };
        } else {
          replaceNonce = rec.pending.nonce;
        }
      }
      if (attempt > this.policy.maxAttempts) throw new PermanentFailure(`gave up after ${this.policy.maxAttempts} attempts`);

      const tx = await step.plan(this.state.ctx, this.chain, { sabotage });
      if (!tx) {
        const summary = await step.verify(this.state.ctx, this.chain, null);
        this.log(rec.name, "nothing to send", { summary });
        return { kind: "finished", summary: null };
      }
      // The sabotaged attempt is sent unsimulated so the revert really happens on chain.
      if (!(sabotage && attempt === 1)) {
        const sim = await this.chain.simulate(tx);
        if (!sim.ok) {
          this.log(rec.name, "simulation fails on fresh state", { attempt, reason: sim.reason });
          throw new PermanentFailure(`can't succeed on the current state: ${sim.reason}`);
        }
        if (attempt > 1) this.log(rec.name, "simulation passes on fresh state, retrying", { attempt });
      }

      const base = await this.chain.baseFee();
      const underpriced = this.faults.dropAt === step.name && attempt === 1;
      const fees: Fees = underpriced
        ? { maxFeePerGas: UNDERPRICED, maxPriorityFeePerGas: 0n }
        : { maxFeePerGas: base * this.policy.feeMultiplier + BigInt(attempt - 1) * base, maxPriorityFeePerGas: BigInt(attempt - 1) * 1_000_000_000n };
      const nonce = replaceNonce ?? (await this.chain.pendingNonce());
      this.log(rec.name, "sending", { attempt, nonce, maxFeeGwei: Number(fees.maxFeePerGas) / 1e9, replacing: replaceNonce !== undefined, underpriced, sabotage: sabotage && attempt === 1 });
      let hash: Hex;
      try {
        hash = await this.chain.send(tx, nonce, fees);
      } catch (e) {
        this.log(rec.name, "node refused the transaction", { attempt, reason: (e as Error).message.split("\n")[0] });
        return { kind: "again" };
      }
      rec.txs.push(hash);
      rec.pending = { nonce, hashes: [...(rec.pending?.nonce === nonce ? rec.pending.hashes : []), hash] };
      this.log(rec.name, "sent", { attempt, tx: hash });
      const r = await this.chain.waitReceipt(hash, this.policy.receiptTimeoutMs);
      if (!r) {
        this.log(rec.name, "not mined in time, will replace", { attempt, tx: hash, waitedSec: this.policy.receiptTimeoutMs / 1000 });
        return { kind: "again", replaceNonce: nonce }; // rec.pending stays: checked once more, then replaced
      }
      const outcome = await this.settle(step, rec, r);
      if (outcome !== "retry") return { kind: "finished", summary: outcome };
      return { kind: "again" };
    }
  }

  /** A receipt arrived: verify it, or report a revert so the caller rebuilds and retries. */
  private async settle(step: Step<C>, rec: { name: string; pending?: Pending }, r: Receipt): Promise<string | "retry"> {
    rec.pending = undefined;
    if (r.status === "reverted") {
      const reason = this.chain.whyReverted ? await this.chain.whyReverted(r.hash).catch(() => undefined) : undefined;
      this.log(rec.name, "reverted", { tx: r.hash, block: Number(r.block), reason });
      return "retry";
    }
    this.log(rec.name, "confirmed", { tx: r.hash, block: Number(r.block), gasUsed: Number(r.gasUsed) });
    try {
      return await step.verify(this.state.ctx, this.chain, r);
    } catch (e) {
      throw new PermanentFailure(`receipt doesn't show the expected result: ${(e as Error).message}`);
    }
  }
}

export function newState<C>(id: string, kind: string, steps: Step<C>[], ctx: C): SagaState<C> {
  return { id, kind, status: "running", steps: steps.map((s) => ({ name: s.name, title: s.title, state: "pending", txs: [] })), ctx };
}
