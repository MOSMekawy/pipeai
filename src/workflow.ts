import {
  createUIMessageStream,
  type UIMessage,
  type UIMessageStreamWriter,
} from "ai";
import { type Agent } from "./agent";
import { computeStepShapeHash, deepFreeze, warnOnce, SKIP, type MaybePromise } from "./utils";
import { TransformStep } from "./steps/transform-step";
import { AgentStep } from "./steps/agent-step";
import { PredicateBranchStep, SelectBranchStep } from "./steps/branch-step";
import { ForeachStep } from "./steps/foreach-step";
import { ParallelStep } from "./steps/parallel-step";
import { GateStep, type GateStepOptions } from "./steps/gate-step";
import { CatchStep } from "./steps/catch-step";
import { FinallyStep } from "./steps/finally-step";
import { NestedWorkflowStep } from "./steps/nested-workflow-step";
import { RepeatStep } from "./steps/repeat-step";
import { Step } from "./steps/step";

// The public type / API surface lives in ./types. Re-export it so existing
// `from "./workflow"` consumers (index.ts, tests) are unchanged, and import the
// subset this file references internally.
export type * from "./types";
import type {
  GateSnapshot, CheckpointSnapshot, LegacyGateSnapshotV1, WorkflowSnapshot,
  WorkflowStepType, WorkflowObservability, RunOptions,
  StepOptions, InlineStepOptions, ConditionalStepOptions, NestedStepOptions,
  BranchCase, BranchSelect, WorkflowResult, WorkflowStreamResult,
  WorkflowStreamOptions, LoopPredicate, RepeatOptions, ParallelTarget,
  ParallelOptions, ParallelOutputRecord, ParallelOutputTuple,
  ParallelOutputRecordPartial, ParallelOutputTuplePartial, SchemaWithParse,
  SkipPassthrough, ElementOf, NoGates, GatelessBranch, ForeachOptions,
} from "./types";

// Error classes + reserved synthetic step ids live in the leaf `./errors`
// module (no internal imports, so steps can reach them without a value cycle).
// Re-exported here so `from "./workflow"` consumers (index.ts, tests) are
// unchanged.
import {
  WorkflowBranchError, WorkflowLoopError,
  CHECKPOINT_STEP_ID, ABORT_STEP_ID, GATE_RESUME_STEP_ID,
} from "./errors";
export { WorkflowBranchError, WorkflowLoopError, CHECKPOINT_STEP_ID, ABORT_STEP_ID, GATE_RESUME_STEP_ID };

// Runtime plumbing (per-run state, observability dispatch, warnings, checkpoint
// sink, pending-error demotion) lives in ./runtime. The `RuntimeState` /
// `PendingError` / `ResumeDescent` types live there too.
import {
  resolveFreezeSnapshots, pendingErrorSourceToStepType, emitCheckpoint,
  __resetStreamOnErrorOnSuspendWarnForTests, pushWarning, demotePendingError,
  maybeWarnStreamOnErrorOnSuspend, makeRuntimeState, makeAbortError,
  fireHook as fireHookFree,
} from "./runtime";
import type { RuntimeState, PendingError, ResumeDescent } from "./runtime";
export type { RuntimeState, PendingError, ResumeDescent } from "./runtime";
// Tests reach for this one-shot warn reset via `from "../workflow"`.
export { __resetStreamOnErrorOnSuspendWarnForTests };

/**
 * Convert a legacy v1 gate snapshot to a v2 gate snapshot. Long-lived
 * storage (Redis-without-TTL, S3, Postgres) should re-serialize via this
 * helper before v0.8.0+ drops v1 acceptance.
 */
export function migrateSnapshot(legacy: LegacyGateSnapshotV1): GateSnapshot {
  if (legacy.version !== 1) {
    throw new Error(`migrateSnapshot: expected v1 snapshot, got version ${(legacy as { version: number }).version}`);
  }
  return {
    version: 2,
    kind: "gate",
    resumeFromIndex: legacy.resumeFromIndex,
    output: legacy.output,
    gateId: legacy.gateId,
    gatePayload: legacy.gatePayload,
  };
}

/**
 * Seed for a run: the initial pipeline `output` plus an optional pre-execute
 * `initialError`. The resume entry points compute these differently (gate
 * schema-parse + merge vs. plain snapshot output), but every entry point then
 * funnels through the same `runGenerate` / `runStream` machinery.
 */
type StateSeed = { output: unknown; initialError: PendingError | null; resumeDescent?: ResumeDescent };

// ── Sealed Workflow (returned by finally — execution only) ───────────

export class SealedWorkflow<
  TContext,
  TInput = void,
  TOutput = void,
  TGates extends Record<string, unknown> = {},
> {
  readonly id?: string;
  protected readonly steps: ReadonlyArray<Step>;
  protected readonly observability?: WorkflowObservability;
  // Memoized — see ensureDuplicateCheck().
  private duplicateCheckPassed = false;
  // Memoized lazily per terminal instance: the executable / checkpointable step
  // counts (one walk) and the recursive shape hash (separate — it's expensive).
  private _stepCounts?: { executable: number; checkpointable: number };
  private _cachedStepShapeHash?: string;

  protected constructor(steps: ReadonlyArray<Step>, id?: string, observability?: WorkflowObservability) {
    this.steps = steps;
    this.id = id;
    this.observability = observability;
  }

  // ── Construction-time validation (memoized per terminal instance) ────

  /**
   * Walk the step list once per terminal instance. Rejects:
   *   - Duplicate `(type, id)` pairs.
   *   - User step ids containing the reserved `::pipeai::` namespace
   *     (CHECKPOINT_STEP_ID lives there).
   */
  private ensureDuplicateCheck(): void {
    if (this.duplicateCheckPassed) return;
    const seen = new Map<string, number>();
    for (let i = 0; i < this.steps.length; i++) {
      const node = this.steps[i];
      if (node.id.includes("::pipeai::")) {
        throw new Error(
          `Workflow: step id "${node.id}" uses the reserved "::pipeai::" namespace at index ${i}.`
        );
      }
      const key = `${node.type}:${node.id}`;
      const prior = seen.get(key);
      if (prior !== undefined) {
        throw new Error(
          `Workflow: duplicate (${node.type}, "${node.id}") at indices ${prior} and ${i}. ` +
          `Pass an explicit \`{ id }\` (e.g. for back-to-back \`branch(...)\` or \`foreach(agentX).foreach(agentX)\`) to disambiguate.`
        );
      }
      seen.set(key, i);
    }
    this.duplicateCheckPassed = true;
  }

  // ── step counts + shape-hash (memoized) ────────────────────────────

  /**
   * Two cadence inputs from a single walk:
   *   - `executable` — nodes that aren't `catch` / `finally`. A graph-size
   *     proxy for the catastrophe threshold in {@link validateRunOptions}.
   *   - `checkpointable` — `type === "step"` nodes only (this includes
   *     branch / foreach / repeat / parallel / nested). Drives the checkpoint
   *     auto-cadence denominator: gates suspend/skip and never reach the
   *     checkpoint block, so counting them would dilute the "~4 checkpoints
   *     across the run" target.
   */
  protected get stepCounts(): { executable: number; checkpointable: number } {
    if (this._stepCounts) return this._stepCounts;
    let executable = 0;
    let checkpointable = 0;
    for (const s of this.steps) {
      if (s.type !== "catch" && s.type !== "finally") executable++;
      if (s.type === "step") checkpointable++;
    }
    return (this._stepCounts = { executable, checkpointable });
  }

  /** @internal — used by `computeStepShapeHash` to descend nested workflows. */
  getStepsForShapeHash(): ReadonlyArray<Step> {
    return this.steps;
  }

  protected get cachedStepShapeHash(): string {
    if (this._cachedStepShapeHash !== undefined) return this._cachedStepShapeHash;
    const getNested = (node: { nestedWorkflow?: SealedWorkflow<unknown, unknown, unknown> }) =>
      node.nestedWorkflow ? [node.nestedWorkflow] : [];
    this._cachedStepShapeHash = computeStepShapeHash(
      this.steps as unknown as ReadonlyArray<{ type: string; id: string }>,
      getNested as unknown as (node: { type: string; id: string }) => readonly { id?: string; getStepsForShapeHash(): ReadonlyArray<{ type: string; id: string }> }[],
    );
    return this._cachedStepShapeHash;
  }

  /**
   * Validate user-provided RunOptions before a run begins. Throws on
   * outright errors and on the loud-disaster combo (`freezeSnapshots: true
   * + checkpointEvery: 1` on a workflow of 8+ steps). Warns once on the
   * merely-suspicious combo (`freezeSnapshots: true + cadence <= 2`), and on
   * checkpoint-cadence options set without an `onCheckpoint` sink (a no-op
   * that usually signals a forgotten sink).
   */
  protected validateRunOptions(opts: RunOptions | undefined): void {
    if (!opts) return;
    if (opts.checkpointEvery !== undefined && opts.checkpointWhen !== undefined) {
      throw new Error("RunOptions: checkpointEvery and checkpointWhen are mutually exclusive");
    }
    if (opts.checkpointEvery !== undefined && (!Number.isInteger(opts.checkpointEvery) || opts.checkpointEvery < 1)) {
      throw new Error(`RunOptions: checkpointEvery must be a positive integer, got ${opts.checkpointEvery}`);
    }
    // Cadence options without a sink do nothing — likely a forgotten sink.
    if (!opts.onCheckpoint) {
      if (opts.checkpointEvery !== undefined || opts.checkpointWhen !== undefined) {
        warnOnce(
          "pipeai:checkpoint-without-sink",
          "pipeai: checkpointEvery/checkpointWhen set without onCheckpoint — no checkpoints will fire. Did you forget the onCheckpoint sink?",
        );
      }
      return;
    }
    const length = this.stepCounts.executable;
    // Cadence is computed from the checkpointable-step count (gates excluded)
    // so this guard predicts the actual runtime cadence; `length` stays the
    // executable-node count as a graph-size proxy for the catastrophe threshold.
    const cadence = opts.checkpointEvery ?? Math.max(1, Math.ceil(this.stepCounts.checkpointable / 4));
    if (opts.freezeSnapshots && opts.freezeSnapshots !== "iAcceptThePerformanceCost" && cadence === 1 && length >= 8) {
      throw new Error(
        `freezeSnapshots+checkpointEvery:1 on a ${length}-step workflow is reliably catastrophic. ` +
        `Set checkpointEvery >= 5, freezeSnapshots: false, or pass "iAcceptThePerformanceCost".`
      );
    }
    if (opts.freezeSnapshots && cadence <= 2) {
      warnOnce(
        "pipeai:freezeSnapshots-low-cadence",
        "pipeai: freezeSnapshots+checkpointEvery<=2 compounds graph-walk cost.",
      );
    }
  }

  // ── Observability helpers ─────────────────────────────────────

  /** Observability event `type` for a node: a `type: "step"` node reports its
   *  `category` (agent / transform default to `"step"`); every other node's
   *  `type` IS the event type. */
  private obsEventType(node: Step): WorkflowStepType {
    if (node.type !== "step") return node.type;
    return node.category ?? "step";
  }

  /**
   * Fire an observability hook safely. Returns `undefined` synchronously when
   * no hook is registered — avoiding the promise wrapper + microtask that an
   * async function would unconditionally allocate on every step boundary.
   *
   * On hook throw:
   *   - non-`onStepError` hooks: warning pushed + console.error.
   *   - `onStepError`: throw is propagated as a return value; the run loop
   *     attaches it as `cause` on the original step error.
   *
   * Returns the hook's thrown error if any; undefined otherwise. Callers
   * `await` the result — `await undefined` is sync, so the no-hook path
   * stays allocation-free.
   *
   * Thin delegate to the free `fireHook` (which takes an explicit
   * observability), kept as a method so the loop's many `this.fireHook` call
   * sites stay unchanged.
   */
  protected fireHook<
    K extends keyof WorkflowObservability,
    E extends Parameters<NonNullable<WorkflowObservability[K]>>[0],
  >(
    state: RuntimeState,
    name: K,
    event: E,
  ): MaybePromise<unknown> {
    return fireHookFree(this.observability, state, name, event);
  }

  /**
   * Fire `onStepError` for a step-body failure and honor the documented
   * cause-attachment contract uniformly across every firing path (step, gate,
   * catch, finally, checkpoint). When the hook itself throws, its error is
   * attached as `cause` on the ORIGINAL error so the original still reaches the
   * caller with the failure trail attached. If the original error is frozen /
   * non-extensible (cause assignment throws) or is not an object, the hook
   * error is recorded as a warning instead — so an `onStepError` throw is never
   * silently lost. (The suspension-wins tail fires `onStepError` separately, on
   * its own demotion path.)
   */
  protected async fireStepErrorAndAttachCause(
    state: RuntimeState,
    event: { stepId: string; type: WorkflowStepType; ctx: unknown; error: unknown; durationMs: number },
  ): Promise<void> {
    const obsError = await this.fireHook(state, "onStepError", event);
    if (obsError === undefined) return;
    const e = event.error;
    if (typeof e === "object" && e !== null) {
      try {
        (e as { cause?: unknown }).cause = obsError;
        return;
      } catch {
        // Original error frozen / non-extensible — fall through to the warning.
      }
    }
    pushWarning(state, "onStepError", event.stepId, obsError);
  }

  // ── Execution ─────────────────────────────────────────────────

  async generate(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, opts?: RunOptions]
      : [input: TInput, opts?: RunOptions]
  ): Promise<WorkflowResult<TOutput>> {
    this.ensureDuplicateCheck();
    const input = args[0];
    const opts = args[1] as RunOptions | undefined;
    return this.runGenerate(ctx, 0, opts, () => ({ output: input, initialError: null }));
  }

  stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
      : [input: TInput, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput, UI_MESSAGE> {
    this.ensureDuplicateCheck();
    const input = args[0];
    const options = args[1] as WorkflowStreamOptions<UI_MESSAGE> | undefined;
    const opts = args[2] as RunOptions | undefined;
    return this.runStream(ctx, 0, opts, options, () => ({ output: input, initialError: null }));
  }

  // Helper — converts terminal RuntimeState into a WorkflowResult; freezes
  // snapshot + warnings if requested via runOptions.
  protected buildResult(state: RuntimeState): WorkflowResult<TOutput> {
    const warnings = state.warnings ?? [];
    // freezeSnapshots freezes the warnings array on BOTH terminal paths
    // (complete and suspended), per the documented contract.
    if (resolveFreezeSnapshots(state)) {
      deepFreeze(warnings);
    }
    if (state.suspension) {
      return { status: "suspended", snapshot: state.suspension, warnings };
    }
    return { status: "complete", output: state.output as TOutput, warnings };
  }

  // ── Shared run drivers (generate / stream) ────────────────────
  // Every public entry point — base generate/stream plus gate- and
  // checkpoint-resume — differs only in (a) how it seeds the initial output /
  // pre-execute error and (b) the start index. Both drivers take a `seed`
  // thunk for (a) and a `startIndex` for (b); the rest (validation, state
  // construction, execute, result building, stream plumbing) is identical.

  protected async runGenerate(
    ctx: unknown,
    startIndex: number,
    opts: RunOptions | undefined,
    seed: () => MaybePromise<StateSeed>,
  ): Promise<WorkflowResult<TOutput>> {
    this.validateRunOptions(opts);
    const seeded = await seed();
    const state = makeRuntimeState(ctx, seeded.output, "generate", opts);
    if (seeded.resumeDescent) state.resumeDescent = seeded.resumeDescent;
    await this.execute(state, startIndex, opts, seeded.initialError);
    return this.buildResult(state);
  }

  protected runStream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: unknown,
    startIndex: number,
    opts: RunOptions | undefined,
    options: WorkflowStreamOptions<UI_MESSAGE> | undefined,
    seed: () => MaybePromise<StateSeed>,
  ): WorkflowStreamResult<TOutput, UI_MESSAGE> {
    this.validateRunOptions(opts);

    let resolveOutput!: (value: WorkflowResult<TOutput>) => void;
    let rejectOutput!: (error: unknown) => void;
    const outputPromise = new Promise<WorkflowResult<TOutput>>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    // Prevent unhandled rejection warning if the consumer never awaits `output`.
    outputPromise.catch(() => {});

    const stream = createUIMessageStream<UI_MESSAGE>({
      execute: async ({ writer }) => {
        // Seeding (gate schema-parse + merge) runs here, inside the stream's
        // error pipeline — a throw must surface as a rejected `output`/stream,
        // not escape synchronously from `.stream(...)`. The resume seeds catch
        // their own errors into `initialError` so `.catch()` can observe them.
        try {
          const seeded = await seed();
          const state = makeRuntimeState(ctx, seeded.output, "stream", opts, writer);
          if (seeded.resumeDescent) state.resumeDescent = seeded.resumeDescent;
          await this.execute(state, startIndex, opts, seeded.initialError);
          const result = this.buildResult(state);
          maybeWarnStreamOnErrorOnSuspend(result, options);
          resolveOutput(result);
        } catch (error) {
          rejectOutput(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
      ...(options?.originalMessages ? { originalMessages: options.originalMessages } : {}),
      ...(options?.generateId ? { generateId: options.generateId } : {}),
    });

    return { stream, output: outputPromise };
  }

  // ── Internal: execute pipeline ────────────────────────────────

  protected async execute(
    state: RuntimeState,
    startIndex: number = 0,
    opts?: RunOptions,
    initialError: PendingError | null = null,
  ): Promise<void> {
    if (this.steps.length === 0) {
      throw new Error("Workflow has no steps. Add at least one step before calling generate() or stream().");
    }

    // Make sure runOptions is plumbed even if the caller didn't initialize state.
    if (opts !== undefined && state.runOptions === undefined) {
      state.runOptions = opts;
    }

    // Hoisted once per run — the numeric cadence form has no per-step input,
    // so recomputing it per iteration was pure overhead.
    const ckptCadence = opts?.onCheckpoint && opts.checkpointWhen === undefined
      ? (opts.checkpointEvery ?? Math.max(1, Math.ceil(this.stepCounts.checkpointable / 4)))
      : 0;

    // Counts completed executable step bodies (not raw loop indices), so the
    // numeric `checkpointEvery` cadence means "every N executable steps" even
    // when catch/finally nodes are interleaved. Boxed so `maybeCheckpoint` can
    // advance it.
    const ckptCounter = { seen: 0 };

    // `state.pendingError` is the single source of truth for the in-flight
    // error — steps park their captured throws there, and `catch`/`finally`
    // steps read/clear it. `initialError` lets callers (e.g.
    // ResumedWorkflow.stream) seed the pipeline already-in-error so a
    // pre-execute failure (schema.parse, merge throw) flows through downstream
    // `.catch()` like any other step failure instead of escaping synchronously.
    state.pendingError = initialError ?? undefined;

    // Tracks whether the abort signal has already been promoted into
    // pendingError in this execute() pass (see `promoteAbort`).
    const abortState = { promoted: false };

    for (let i = startIndex; i < this.steps.length; i++) {
      // Abort checkpoint — runs at every iteration boundary, before any
      // node dispatch, so finally/catch nodes that come AFTER the abort
      // still get to run (cleanup + recovery contract).
      this.promoteAbort(state, abortState);

      const node = this.steps[i];

      // Run policy is the node's own business: `finally` always runs, `catch`
      // runs only on a pending error (and never while suspended / after a
      // checkpoint failure), every other kind is skipped while suspended or in
      // error. Skipped nodes fire NO hooks.
      if (node.shouldSkip(state)) continue;

      // Uniform dispatch: every node is a `Step`. A normal step runs its body
      // and parks any error on `state.pendingError` (recoverable by `.catch()`).
      // The error-handling layer is different: a `catch`/`finally` body that
      // throws does NOT park — it bubbles out of `execute`. We surface it to
      // observers via onStepError, then re-throw so it leaves the run (no
      // `.catch()`, no aggregation). Observability type comes from the category.
      const obsType = this.obsEventType(node);
      const stepId = node.id;
      const sStart = performance.now();
      const errBefore = state.pendingError;
      // A `finally` runs while a gate's suspension is still parked; only the
      // gate that NEWLY parks one reports `suspended: true`. Capture the prior
      // state so the finish hook attributes suspension to the right node.
      const suspendedBefore = !!state.suspension;
      state.stepIndex = i;   // consumed by GateStep for `resumeFromIndex`.
      await this.fireHook(state, "onStepStart", { stepId, type: obsType, ctx: state.ctx, input: state.output });
      try {
        await node.execute(state);
      } catch (e) {
        await this.fireStepErrorAndAttachCause(state, {
          stepId, type: obsType, ctx: state.ctx, error: e,
          durationMs: performance.now() - sStart,
        });
        throw e;
      }

      // Reconcile observability against what the step did. A newly-parked error
      // (distinct from the one we entered with) routes to onStepError, typed by
      // the node's category and honoring the cause-attachment contract;
      // otherwise the step finished — `suspended` reflects a gate parking.
      const newError = state.pendingError && state.pendingError !== errBefore ? state.pendingError : null;
      // An abort that a nested workflow / concurrent unit already rethrew lands
      // here parked under the CHILD step's id. It's a cancellation, not a
      // step-logic failure — emit no step-level event (promoteAbort re-parks it,
      // settleRun throws it). Without this the child step reports a phantom
      // failure that duplicates the abort the caller already gets.
      const isAbort = !!newError && state.abortSignal?.aborted === true && newError.error === state.abortSignal.reason;
      if (isAbort) {
        // Cancellation owns the error; no onStepStart/Finish/Error pairing.
      } else if (newError) {
        await this.fireStepErrorAndAttachCause(state, {
          stepId, type: obsType, ctx: state.ctx, error: newError.error,
          durationMs: performance.now() - sStart,
        });
      } else {
        await this.fireHook(state, "onStepFinish", {
          stepId, type: obsType, ctx: state.ctx, output: state.output,
          durationMs: performance.now() - sStart, suspended: !suspendedBefore && !!state.suspension,
        });
      }

      // Defensive invariant: only a gate — or a `nested` step propagating a
      // child gate's suspension up — may park a suspension. A `type:"step"` node
      // is skipped while suspended (above), so a suspension present after any
      // OTHER category's body leaked from a coding bug. (foreach/parallel run
      // branches on separate item states, so they never set the parent's
      // suspension; repeat forbids gated targets at build time.)
      if (node.type === "step" && node.category !== "nested" && state.suspension) {
        const leaked = state.suspension;
        state.suspension = undefined;
        throw new Error(`internal: suspension bubbled from non-gate step "${node.id}" (gate "${leaked.gateId}").`);
      }

      await this.maybeCheckpoint(state, opts, node, i, ckptCadence, ckptCounter);
    }

    await this.settleRun(state, abortState.promoted);
  }

  /**
   * Promote a fired abort signal into `state.pendingError` at an iteration
   * boundary. First observation discards any in-progress suspension (the caller
   * asked to stop) and preserves a genuinely-different prior step error as a
   * warning — but NOT one that is itself the abort reason (a nested workflow /
   * concurrent unit that already rethrew it), which would surface a phantom
   * step-failure warning. Subsequent iterations only re-promote if a downstream
   * catch cleared pendingError — `AbortSignal.aborted` is sticky, so the
   * workflow must not resume mid-pipeline just because a catch swallowed one
   * observation.
   */
  private promoteAbort(state: RuntimeState, abortState: { promoted: boolean }): void {
    const signal = state.abortSignal;
    if (!signal?.aborted) return;
    if (!abortState.promoted) {
      abortState.promoted = true;
      state.suspension = undefined;
      const prior = state.pendingError;
      // Skip demotion when the in-flight error IS the abort reason — it already
      // represents this abort, so re-recording it as a warning is noise.
      if (prior && prior.error !== signal.reason) demotePendingError(state, prior);
      state.pendingError = makeAbortError(signal);
    } else if (!state.pendingError) {
      // A catch handler swallowed the abort. Re-promote so downstream steps
      // still see the signal as the "stop" condition the caller requested.
      state.pendingError = makeAbortError(signal);
    }
  }

  /**
   * Emit a checkpoint after a successful `type:"step"` body. Skipped on
   * pendingError (no clean state to snapshot), on suspension (gate already
   * won), and for catch/finally/gate nodes (not checkpointable). Numeric
   * `checkpointEvery` (default: `max(1, ceil(count/4))`) uses the loop-hoisted
   * `ckptCadence`; the predicate form runs per step. A `when:false`-skipped
   * `type:"step"` node returns normally (its body never ran) and still reaches
   * here — it advances the counter and can itself be a checkpoint boundary,
   * keeping the cadence denominator (`stepCounts.checkpointable`) consistent
   * with the runtime counter.
   */
  private async maybeCheckpoint(
    state: RuntimeState,
    opts: RunOptions | undefined,
    node: Step,
    index: number,
    ckptCadence: number,
    counter: { seen: number },
  ): Promise<void> {
    if (node.type !== "step" || state.pendingError || state.suspension || !opts?.onCheckpoint) return;
    counter.seen++;
    const shouldCheckpoint = opts.checkpointWhen
      ? opts.checkpointWhen({ stepIndex: index, stepId: node.id, ctx: state.ctx })
      : counter.seen % ckptCadence === 0;
    if (!shouldCheckpoint) return;
    const ckptStart = performance.now();
    try {
      await emitCheckpoint(state, opts, index + 1, this.cachedStepShapeHash);
    } catch (e) {
      state.pendingError = { error: e, stepId: CHECKPOINT_STEP_ID, source: "onCheckpoint" };
      state.checkpointFailed = true;
      // Route through onStepError with the synthetic CHECKPOINT_STEP_ID and
      // type: "step" (matches pendingErrorSourceToStepType("onCheckpoint")).
      await this.fireStepErrorAndAttachCause(state, {
        stepId: CHECKPOINT_STEP_ID, type: "step", ctx: state.ctx, error: e,
        durationMs: performance.now() - ckptStart,
      });
    }
  }

  /**
   * Terminal reconciliation after the loop. Re-promotes a swallowed abort
   * (recoverability must not depend on catch position), then resolves the
   * mutually-exclusive precedence tail: checkpointFailed > original-step error
   * > suspension. (A throwing catch/finally never reaches here — it bubbles
   * straight out of the loop, so there is no finally-aggregation branch.)
   */
  private async settleRun(state: RuntimeState, abortPromoted: boolean): Promise<void> {
    // Abort is sticky and non-recoverable. The in-loop re-promotion prevents a
    // `.catch()` from resuming a pipeline mid-flight, but a *terminal* `.catch()`
    // that clears the promoted abort has no subsequent iteration to re-promote
    // it — so without this the run would report `complete` while
    // `.catch().finally()` correctly rejects. Guarded by `abortPromoted`: only
    // re-promote an abort already observed this pass (a catch cleared it), not
    // one whose checkpointFailed precedence must win below.
    if (abortPromoted && !state.pendingError && !state.suspension && state.abortSignal?.aborted) {
      state.pendingError = makeAbortError(state.abortSignal);
    }

    if (state.pendingError && !state.suspension) {
      const pe = state.pendingError;
      if (state.checkpointFailed) {
        // The checkpoint error reaches the caller bare. Every OTHER error
        // accumulated this run — step/gate errors demoted to warnings (e.g. by
        // abort promotion) — cannot ride the rejection (it carries a single
        // error, not the warnings array), so surface them via console.warn
        // rather than dropping them silently.
        const warningsArr = state.warnings ?? [];
        const checkpointError = pe.source === "onCheckpoint"
          ? pe.error
          : warningsArr.find(w => w.source === "onCheckpoint")?.error;
        const suppressed = warningsArr
          .filter(w => w.error !== checkpointError)
          .map(w => w.error);
        if (pe.source !== "onCheckpoint" && pe.error !== checkpointError) {
          suppressed.push(pe.error);
        }
        if (suppressed.length > 0) {
          console.warn(
            `pipeai: ${suppressed.length} error(s) suppressed by checkpoint-failure precedence:`,
            suppressed,
          );
        }
        throw checkpointError ?? pe.error;
      }
      throw pe.error;
    } else if (state.pendingError && state.suspension) {
      // Suspension wins; preserve the step error as a warning.
      const pe = state.pendingError;
      demotePendingError(state, pe);
      // Also emit onStepError so observers can see the loss.
      try {
        await this.observability?.onStepError?.({
          stepId: pe.stepId,
          type: pendingErrorSourceToStepType(pe.source),
          ctx: state.ctx,
          error: pe.error,
          durationMs: 0,
        });
      } catch (obsError) {
        pushWarning(state, "onStepError", pe.stepId, obsError);
      }
      state.pendingError = undefined;
    }
  }

  /**
   * Run THIS sealed workflow as a nested step on the caller's run `state`.
   * Public (internal; not re-exported from index) so `Step` subclasses —
   * `nested` / `repeat` / `foreach` / `parallel` with `SealedWorkflow` targets
   * — can run a sub-workflow without reaching the protected `execute`.
   *
   * Contract: RunOptions is run-scoped, so the child never inherits the
   * parent's (`state.warnings` IS propagated — telemetry > config). A gate
   * inside the child leaves `state.suspension` set so it propagates up (only a
   * `.step(workflow)` ever does this — concurrent/looped combinators forbid
   * gated targets at build time).
   */
  async executeAsNested(state: RuntimeState, startIndex: number = 0): Promise<void> {
    const savedRunOptions = state.runOptions;
    state.runOptions = undefined;
    try {
      await this.execute(state, startIndex);
    } finally {
      state.runOptions = savedRunOptions;
    }
    // A gate inside this nested workflow leaves `state.suspension` set; it
    // propagates up as a first-class suspension (NOT an error). The calling
    // `NestedWorkflowStep` prepends its own step index to the snapshot path so
    // resume can descend back here, and the run loop relaxes its
    // leaked-suspension invariant for `nested` nodes. (Concurrent/looped
    // combinators — foreach / parallel / repeat — forbid gated targets at build
    // time, so they never observe a propagated suspension.)
  }

  // ── Gate: load persisted state for resumption ──────────────────

  loadState<K extends string & keyof TGates>(
    gateId: K,
    snapshot: WorkflowSnapshot,
  ): ResumedWorkflow<TContext, TGates[K], TOutput> {
    // Reject checkpoint snapshots — they belong to resumeFrom(), not loadState().
    if (snapshot.version === 2 && snapshot.kind === "checkpoint") {
      throw new Error(`loadState: received a checkpoint snapshot. Use resumeFrom() for checkpoint resume; loadState() is for gates.`);
    }
    const gateLike = snapshot as GateSnapshot | LegacyGateSnapshotV1;
    if (gateLike.gateId !== gateId) {
      throw new Error(
        `loadState: gate ID mismatch — expected "${gateId}" but snapshot has "${gateLike.gateId}".`
      );
    }
    this.ensureDuplicateCheck();

    const nestedPath = (gateLike as GateSnapshot).nestedPath;
    if (nestedPath && nestedPath.length > 0) {
      // Nested gate: walk the path to the innermost workflow that owns the gate
      // (for its schema/merge), then resume the ROOT at the first nested step
      // and descend back down (see `ResumeDescent`).
      let steps: ReadonlyArray<Step> = this.steps;
      for (const idx of nestedPath) {
        const child = steps[idx]?.nestedWorkflow;
        if (!child) {
          throw new Error(`loadState: nested gate "${gateId}" path is stale — step ${idx} is not a nested workflow.`);
        }
        steps = child.getStepsForShapeHash();
      }
      const innerGate = steps[gateLike.resumeFromIndex];
      if (!(innerGate instanceof GateStep) || innerGate.id !== gateId) {
        throw new Error(`loadState: nested gate "${gateId}" not found at the recorded path.`);
      }
      // Descent: root resumes from nestedPath[0]; each nested step descends the
      // next path index; the innermost runs from gate+1 with the merged response.
      const remaining = [...nestedPath.slice(1), gateLike.resumeFromIndex + 1];
      return new ResumedWorkflow<TContext, TGates[K], TOutput>(this.steps, nestedPath[0], {
        mode: "gate",
        schema: innerGate.schema as SchemaWithParse<TGates[K]> | undefined,
        mergeFn: innerGate.merge,
        priorOutput: gateLike.output,
        snapshot: gateLike,
        observability: this.observability,
        nestedRemaining: remaining,
      });
    }

    const gateIndex = this.findGateIndex(gateLike);
    // findGateIndex guarantees a GateStep at this index.
    const gateNode = this.steps[gateIndex] as GateStep;
    return new ResumedWorkflow<TContext, TGates[K], TOutput>(this.steps, gateIndex + 1, {
      mode: "gate",
      schema: gateNode.schema as SchemaWithParse<TGates[K]> | undefined,
      mergeFn: gateNode.merge,
      priorOutput: gateLike.output,
      snapshot: gateLike,
      observability: this.observability,
    });
  }

  // ── Checkpoint resume ──────────────────────────────────────────

  /**
   * Resume from a checkpoint snapshot. Validates the step-shape hash unless
   * `{ skipShapeCheck: true }` is passed. Throws on:
   *   - gate snapshots (use `loadState` instead)
   *   - missing/corrupted `stepShapeHash`
   *   - shape mismatch (unless skipped)
   *   - out-of-bounds `resumeFromIndex`
   *   - 0-step workflow (structural invariant)
   *
   * Returns a `CheckpointResumedWorkflow` whose `generate(ctx, opts?)` takes
   * NO response arg — the state is seeded from the snapshot's output. The
   * matching gate-resume path (`loadState`) keeps the `response` arg.
   */
  resumeFrom(
    snapshot: WorkflowSnapshot,
    options?: { skipShapeCheck?: boolean },
  ): CheckpointResumedWorkflow<TContext, TOutput> {
    // Detect gate snapshots (v2 with kind="gate" OR legacy v1 with gateId).
    const isGate = (snapshot.version === 2 && snapshot.kind === "gate")
      || (snapshot.version === 1 && (snapshot as LegacyGateSnapshotV1).gateId !== undefined);
    if (isGate) {
      throw new Error(`resumeFrom: received a gate snapshot. Use loadState() for gate resume; resumeFrom() is for checkpoints.`);
    }
    if (this.steps.length === 0) {
      throw new Error("resumeFrom: workflow has no steps; snapshot is structurally invalid.");
    }
    const ckpt = snapshot as CheckpointSnapshot;
    const idx = ckpt.resumeFromIndex;
    if (!Number.isInteger(idx) || idx < 0 || idx > this.steps.length) {
      throw new Error(`resumeFrom: resumeFromIndex (${idx}) out of bounds for ${this.steps.length}-step workflow.`);
    }
    if (!options?.skipShapeCheck) {
      if (!ckpt.stepShapeHash) {
        throw new Error("resumeFrom: snapshot missing stepShapeHash; corrupted or hand-crafted.");
      }
      this.ensureDuplicateCheck();
      if (this.cachedStepShapeHash !== ckpt.stepShapeHash) {
        throw new Error("resumeFrom: workflow shape mismatch; cannot safely resume. Pass { skipShapeCheck: true } to override.");
      }
    } else {
      this.ensureDuplicateCheck();
    }
    return new CheckpointResumedWorkflow<TContext, TOutput>(this.steps, idx, {
      priorOutput: ckpt.output,
      observability: this.observability,
    });
  }

  /**
   * Append a `.finally()` body to a sealed workflow, returning another sealed
   * workflow. Allows multi-finally chains (`.finally().finally()`). A throwing
   * `.finally` body bubbles straight out of the run: it is non-recoverable, does
   * NOT aggregate with a prior error, and subsequent `.finally()` bodies do not
   * run. (See {@link FinallyStep} for the full contract.)
   */
  finally(
    id: string,
    fn: (params: { ctx: Readonly<TContext> }) => MaybePromise<void>,
  ): SealedWorkflow<TContext, TInput, TOutput, TGates> {
    const node = new FinallyStep(id, fn as (params: { ctx: Readonly<unknown> }) => MaybePromise<void>);
    return new SealedWorkflow<TContext, TInput, TOutput, TGates>([...this.steps, node], this.id, this.observability);
  }

  private findGateIndex(snapshot: GateSnapshot | LegacyGateSnapshotV1): number {
    // Accepted: v1 (legacy gate-only) and v2 (gate or checkpoint). Gate-flavor
    // v2 is discriminated by kind === "gate"; legacy v1 has no `kind`.
    if (snapshot.version !== 1 && snapshot.version !== 2) {
      throw new Error(`Unsupported snapshot version: ${(snapshot as { version: number }).version}`);
    }

    // Fast path — only when the hint is a sane integer in range AND points at the right gate.
    // Rejects -1, NaN, Infinity, 999999, fractional indices.
    const hint = snapshot.resumeFromIndex;
    if (Number.isInteger(hint) && hint >= 0 && hint < this.steps.length) {
      const node = this.steps[hint];
      if (node.type === "gate" && node.id === snapshot.gateId) {
        return hint;
      }
    }

    // Fallback — scan all steps by gate id (reorder-tolerant).
    for (let i = 0; i < this.steps.length; i++) {
      const node = this.steps[i];
      if (node.type === "gate" && node.id === snapshot.gateId) {
        return i;
      }
    }

    throw new Error(
      `Gate "${snapshot.gateId}" not found in workflow. The workflow definition may have changed since the snapshot was created.`
    );
  }
}

// ── Resumed Workflow ──────────────────────────────────────────────────

interface ResumedWorkflowConfig {
  readonly mode: "gate";
  readonly schema?: SchemaWithParse<unknown>;
  readonly mergeFn?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;
  readonly priorOutput?: unknown;
  readonly snapshot?: WorkflowSnapshot;
  readonly observability?: WorkflowObservability;
  /**
   * Set only for a NESTED gate resume: the descent (child start-indices per
   * level, innermost-last) the merged gate response rides down to the suspended
   * child. When present, `startIndex` is the ROOT's nested-step index and the
   * seed sets `state.resumeDescent` instead of the root `output`.
   */
  readonly nestedRemaining?: readonly number[];
}

export class ResumedWorkflow<
  TContext,
  TResponse = unknown,
  TOutput = void,
> extends SealedWorkflow<TContext, TResponse, TOutput> {
  private readonly startIndex: number;
  private readonly schema?: SchemaWithParse<TResponse>;
  private readonly mergeFn?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;
  private readonly priorOutput: unknown;
  private readonly nestedRemaining?: readonly number[];

  /** @internal */
  constructor(
    steps: ReadonlyArray<Step>,
    startIndex: number,
    config: ResumedWorkflowConfig,
  ) {
    super(steps, undefined, config.observability);
    this.startIndex = startIndex;
    this.schema = config.schema as SchemaWithParse<TResponse> | undefined;
    this.mergeFn = config.mergeFn;
    this.priorOutput = config.priorOutput;
    this.nestedRemaining = config.nestedRemaining;
  }

  private validateResponse(response: TResponse): TResponse {
    if (this.schema) {
      return this.schema.parse(response) as TResponse;
    }
    return response;
  }

  /**
   * Seed the run by validating the gate response and merging it with the
   * suspended output. Runs schema.parse + mergeFn inside a try so a failure
   * becomes a pre-execute `initialError` (routed through `.catch()`) rather
   * than escaping the run synchronously. On error the output falls back to the
   * prior (pre-gate) output.
   */
  private async seedFromResponse(rawResponse: TResponse): Promise<StateSeed> {
    try {
      const response = this.validateResponse(rawResponse);
      const merged = this.mergeFn
        ? await this.mergeFn({ priorOutput: this.priorOutput, response })
        : response;
      if (this.nestedRemaining) {
        // Nested gate: the merged response rides the descent down to the
        // suspended child. The root output is unused (the first node executed is
        // the descent's nested step), so park `priorOutput` there.
        return {
          output: this.priorOutput,
          initialError: null,
          resumeDescent: { remaining: this.nestedRemaining, seedOutput: merged },
        };
      }
      return { output: merged, initialError: null };
    } catch (error) {
      return { output: this.priorOutput, initialError: { error, stepId: GATE_RESUME_STEP_ID, source: "step" } };
    }
  }

  override async generate(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, opts?: RunOptions]
      : [response: TResponse, opts?: RunOptions]
  ): Promise<WorkflowResult<TOutput>> {
    const rawResponse = args[0] as TResponse;
    const opts = args[1] as RunOptions | undefined;
    return this.runGenerate(ctx, this.startIndex, opts, () => this.seedFromResponse(rawResponse));
  }

  override stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
      : [response: TResponse, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput, UI_MESSAGE> {
    const rawResponse = args[0] as TResponse;
    const options = args[1] as WorkflowStreamOptions<UI_MESSAGE> | undefined;
    const opts = args[2] as RunOptions | undefined;
    return this.runStream(ctx, this.startIndex, opts, options, () => this.seedFromResponse(rawResponse));
  }
}

// ── Checkpoint-Resumed Workflow ──────────────────────────────────────
//
// Used by `resumeFrom()`. Same step list, different entry index — no
// gate-merge logic (no response argument) because the state is seeded
// from the checkpoint snapshot's `output`. To keep gate-resume's
// `loadState` form ergonomic, this is a separate class instead of
// overloading ResumedWorkflow's generate().

export class CheckpointResumedWorkflow<
  TContext,
  TOutput = void,
> extends SealedWorkflow<TContext, void, TOutput> {
  private readonly startIndex: number;
  private readonly priorOutput: unknown;

  /** @internal */
  constructor(
    steps: ReadonlyArray<Step>,
    startIndex: number,
    config: { priorOutput?: unknown; observability?: WorkflowObservability },
  ) {
    super(steps, undefined, config.observability);
    this.startIndex = startIndex;
    this.priorOutput = config.priorOutput;
  }

  // Override with widened arg list compatible with parent's `[input?, opts?]`.
  // Inputs are ignored — state is seeded from the snapshot's `output` field.
  override async generate(
    ctx: TContext,
    ...args: [input?: void, opts?: RunOptions]
  ): Promise<WorkflowResult<TOutput>> {
    const opts = args[1];
    return this.runGenerate(ctx, this.startIndex, opts, () => ({ output: this.priorOutput, initialError: null }));
  }

  override stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: [input?: void, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput, UI_MESSAGE> {
    const options = args[1];
    const opts = args[2];
    return this.runStream(ctx, this.startIndex, opts, options, () => ({ output: this.priorOutput, initialError: null }));
  }
}

// ── Workflow ────────────────────────────────────────────────────────

export class Workflow<
  TContext,
  TInput = void,
  TOutput = void,
  TGates extends Record<string, unknown> = {},
> extends SealedWorkflow<TContext, TInput, TOutput, TGates> {

  /**
   * Sentinel value for `foreach`/`parallel`'s `onError` handler. Returning
   * `Workflow.SKIP` omits the failed item (foreach: shortens the output array;
   * parallel: leaves the slot `undefined`). Aliases the leaf-module `SKIP` so
   * the step subclasses can compare against it without importing this class.
   */
  static readonly SKIP = SKIP;

  private constructor(steps: ReadonlyArray<Step> = [], id?: string, observability?: WorkflowObservability) {
    super(steps, id, observability);
  }

  static create<TContext, TInput = void>(
    options?: { id?: string; observability?: WorkflowObservability<TContext> },
  ): Workflow<TContext, TInput, TInput> {
    // The internal representation threads `ctx` as `unknown`; the public
    // option is narrowed to WorkflowObservability<TContext> so user callbacks
    // see their real context type. The cast bridges the contravariant gap.
    return new Workflow<TContext, TInput, TInput>([], options?.id, options?.observability as WorkflowObservability | undefined);
  }

  // `when` without `otherwise` can passthrough the first step → output widens
  // to `TInput | TOutput`, mirroring the `step` overloads. Declared first so it
  // wins when `otherwise` is absent.
  static from<TContext, TInput, TOutput>(
    agent: Agent<TContext, TInput, TOutput>,
    options: StepOptions<TContext, TInput, TOutput> & SkipPassthrough<TContext, TInput, TOutput>
  ): Workflow<TContext, TInput, TInput | TOutput>;
  static from<TContext, TInput, TOutput>(
    agent: Agent<TContext, TInput, TOutput>,
    options?: StepOptions<TContext, TInput, TOutput>
  ): Workflow<TContext, TInput, TOutput>;
  static from<TContext, TInput, TOutput>(
    agent: Agent<TContext, TInput, TOutput>,
    options?: StepOptions<TContext, TInput, TOutput>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Workflow<TContext, TInput, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, any>([]).step(agent, options as any);
  }

  // Builder helper — append a step and return a re-typed Workflow.
  private appendStep<TNext, TG extends Record<string, unknown> = TGates>(
    node: Step,
  ): Workflow<TContext, TInput, TNext, TG> {
    return new Workflow<TContext, TInput, TNext, TG>([...this.steps, node], this.id, this.observability);
  }

  // ── step: agent overload ──────────────────────────────────────
  // `when` without `otherwise` may skip to passthrough → output widens to
  // `TOutput | TNextOutput`. The fallback (no `when`, or `when` + `otherwise`)
  // keeps `TNextOutput`. The passthrough overload is declared first so it wins
  // when `otherwise` is absent.

  step<TNextOutput>(
    agent: Agent<TContext, TOutput, TNextOutput>,
    options: StepOptions<TContext, TOutput, TNextOutput> & SkipPassthrough<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TOutput | TNextOutput, TGates>;
  step<TNextOutput>(
    agent: Agent<TContext, TOutput, TNextOutput>,
    options?: StepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: nested workflow overload ─────────────────────────────
  // The child's gates fold into the parent's `TGates` (`TGates & TChildGates`),
  // so a nested gate is resumable by id via `loadState` AND surfaces to the
  // build-time guard on `foreach`/`parallel`/`repeat` (which forbid gated
  // targets at any nesting depth).

  step<TNextOutput, TChildGates extends Record<string, unknown> = {}>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput, TChildGates>,
    options: NestedStepOptions<TContext, TOutput, TNextOutput> & SkipPassthrough<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TOutput | TNextOutput, TGates & TChildGates>;
  step<TNextOutput, TChildGates extends Record<string, unknown> = {}>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput, TChildGates>,
    options?: NestedStepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates & TChildGates>;

  // ── step: transform overload (replaces map + tap) ─────────────

  step<TNextOutput>(
    id: string,
    fn: (params: { ctx: Readonly<TContext>; input: TOutput; writer?: UIMessageStreamWriter }) => MaybePromise<TNextOutput>,
    options: InlineStepOptions<TContext, TOutput, TNextOutput> & SkipPassthrough<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TOutput | TNextOutput, TGates>;
  step<TNextOutput>(
    id: string,
    fn: (params: { ctx: Readonly<TContext>; input: TOutput; writer?: UIMessageStreamWriter }) => MaybePromise<TNextOutput>,
    options?: InlineStepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: implementation ──────────────────────────────────────

  step<TNextOutput>(
    target: Agent<TContext, TOutput, TNextOutput> | SealedWorkflow<TContext, TOutput, TNextOutput> | string,
    optionsOrFn?: StepOptions<TContext, TOutput, TNextOutput> | NestedStepOptions<TContext, TOutput, TNextOutput> | ((params: { ctx: Readonly<TContext>; input: TOutput; writer?: UIMessageStreamWriter }) => MaybePromise<TNextOutput>),
    inlineOptions?: InlineStepOptions<TContext, TOutput, TNextOutput>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Workflow<TContext, TInput, any, TGates> {
    // Nested workflow overload: step(workflow, options?)
    if (target instanceof SealedWorkflow) {
      const workflow = target;
      const options = optionsOrFn as NestedStepOptions<TContext, TOutput, TNextOutput> | undefined;
      const node = new NestedWorkflowStep(
        options?.id ?? workflow.id ?? "nested-workflow",
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        workflow as SealedWorkflow<any, any, any, any>,
        options as ConditionalStepOptions<unknown, unknown, unknown> | undefined,
      );
      return this.appendStep<TNextOutput>(node);
    }

    // Transform overload: step(id, fn, options?)
    if (typeof target === "string") {
      if (typeof optionsOrFn !== "function") {
        throw new Error(`Workflow step("${target}"): second argument must be a function`);
      }
      const fn = optionsOrFn as (params: { ctx: Readonly<TContext>; input: TOutput; writer?: UIMessageStreamWriter }) => MaybePromise<TNextOutput>;
      const node = new TransformStep(
        target,
        fn as (params: { ctx: unknown; input: unknown; writer?: UIMessageStreamWriter }) => MaybePromise<unknown>,
        inlineOptions as ConditionalStepOptions<unknown, unknown, unknown> | undefined,
      );
      return this.appendStep<TNextOutput>(node);
    }

    // Agent overload: step(agent, options?)
    const agent = target;
    const options = optionsOrFn as StepOptions<TContext, TOutput, TNextOutput> | undefined;
    const node = new AgentStep(
      options?.id ?? agent.id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      agent as Agent<any, any, any>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      options as StepOptions<any, any, any> | undefined,
    );
    return this.appendStep<TNextOutput>(node);
  }

  // ── gate: human-in-the-loop suspension point ────────────────

  gate<TResponse = TOutput, TMerged = TResponse, Id extends string = string>(
    id: Id & (Id extends keyof TGates ? never : Id),
    options?: {
      payload?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<unknown>;
      schema?: SchemaWithParse<TResponse>;
      condition?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
      // `merge` may produce a value of a different type than the validated
      // `response` — `TMerged` (defaults to `TResponse`) becomes the gate's
      // downstream output, while `TGates[Id]` stays `TResponse` (what
      // `loadState` validates as the resume response).
      merge?: (params: { priorOutput: TOutput; response: TResponse }) => MaybePromise<TMerged>;
    }
  ): Workflow<TContext, TInput, TMerged, TGates & Record<Id, TResponse>> {
    if (this.steps.some(s => s.type === "gate" && s.id === id)) {
      throw new Error(`Workflow: duplicate gate ID "${id}". Each gate must have a unique identifier.`);
    }
    // The builder just forwards user options; GateStep wraps `{ctx, input}` and
    // applies the payload default. Function param contravariance forces the cast.
    const node = new GateStep(id, options as unknown as GateStepOptions | undefined);
    return this.appendStep<TMerged, TGates & Record<Id, TResponse>>(node);
  }

  // ── branch: predicate routing (array) ─────────────────────────

  branch<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[],
    options?: { id?: string },
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── branch: key routing (select) ──────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>,
    options?: { id?: string },
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── branch: implementation ────────────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    casesOrConfig: BranchCase<TContext, TOutput, TNextOutput>[] | BranchSelect<TContext, TOutput, TKeys, TNextOutput>,
    options?: { id?: string },
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    const node = Array.isArray(casesOrConfig)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? new PredicateBranchStep(options?.id ?? "branch:predicate", casesOrConfig as BranchCase<any, any, any>[])
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      : new SelectBranchStep(options?.id ?? "branch:select", casesOrConfig as BranchSelect<any, any, any, any>);
    return this.appendStep<TNextOutput>(node);
  }

  // ── foreach: array iteration ─────────────────────────────────

  /**
   * Map each item of an array through an agent or sub-workflow.
   *
   * @param target Agent or `SealedWorkflow` invoked once per item.
   * @param options.id Override the default step id (`foreach:<agentId>` or
   *   the workflow's id). Required when chaining multiple foreach over the same
   *   target — the construction-time `(type, id)` walk rejects duplicates.
   * @param options.concurrency Max items in flight at any moment. **Default:
   *   unbounded** (`Infinity` — every item runs concurrently, clamped only by
   *   item count). Pass an integer to throttle against provider rate limits.
   *   Backed by a worker pool: as soon as one item completes, the next launches —
   *   no lockstep batching.
   * @param options.onError Per-iteration error handler. **Bypassed entirely on
   *   the suspension path** (when any item hits a nested gate) **and on the
   *   cancellation path** (the run was aborted — pre-abort failures become
   *   `foreach-sibling` warnings and the abort reason rethrows) — see the
   *   foreach concurrency hazards in the README. Otherwise: return a
   *   `TNextOutput` value to substitute, return `Workflow.SKIP` to omit, throw
   *   to abort. Invoked sequentially in index order after all items settle.
   *   A throw (or rethrow) from `onError` aborts the foreach immediately:
   *   failures at indices AFTER the throwing one are neither recovered nor
   *   surfaced as warnings.
   */
  // Agent / sub-workflow target form.
  foreach<TNextOutput, TG extends Record<string, unknown> = {}>(
    target: Agent<TContext, ElementOf<TOutput>, TNextOutput> | (SealedWorkflow<TContext, ElementOf<TOutput>, TNextOutput, TG> & NoGates<TG>),
    options?: ForeachOptions<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput[], TGates>;

  // Per-item path-builder form: `foreach(path => path.step(a).step(b), opts)`.
  // The callback receives a sub-builder seeded with the array's element type and
  // returns the built per-item path. Each item runs that whole chain as one
  // concurrent unit (item 0 can be at the last step while item 1 is at the
  // first) — the only barrier is collecting the `TNextOutput[]` at the end. Pure
  // sugar over passing a pre-built `SealedWorkflow`: same behavior, but the
  // element type is inferred so you skip the `Workflow.create<Ctx, Item>()`
  // boilerplate. A gate in the per-item path is forbidden, same as any foreach
  // body (`NoGates`).
  foreach<TNextOutput, TG extends Record<string, unknown> = {}>(
    build: (path: Workflow<TContext, ElementOf<TOutput>, ElementOf<TOutput>>) => (SealedWorkflow<TContext, ElementOf<TOutput>, TNextOutput, TG> & NoGates<TG>),
    options?: ForeachOptions<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput[], TGates>;

  // Implementation
  foreach<TNextOutput>(
    target:
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | Agent<TContext, any, TNextOutput>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | SealedWorkflow<TContext, any, TNextOutput, any>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      | ((path: Workflow<TContext, any, any>) => SealedWorkflow<TContext, any, TNextOutput, any>),
    options?: ForeachOptions<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput[], TGates> {
    // Callback form: build the per-item path from a fresh element-typed builder.
    // The parent's observability is forwarded so steps INSIDE the per-item path
    // fire onStepStart/Finish/Error (the callback form otherwise gives the user
    // no way to attach them). (Agents / SealedWorkflows are objects, never
    // functions, so `typeof` cleanly discriminates the builder callback.)
    const body = typeof target === "function"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? target(Workflow.create<TContext, any>({ observability: this.observability as WorkflowObservability<TContext> | undefined }))
      : target;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = new ForeachStep(body as any, options as any, this.observability);
    return this.appendStep<TNextOutput[]>(node);
  }

  // ── parallel: fan-out combinator ────────────────────────────────
  //
  // Same input fed to each branch. Streaming: agent branches stream only when a
  // `handleStream` is supplied (otherwise they run generate — N agent streams
  // are never auto-merged into one writer); `SealedWorkflow` branches always
  // inherit and stream transitively via their own steps. A `SealedWorkflow`
  // branch containing a gate is rejected at build time (a gate can't suspend one
  // branch of a fan-out).
  //
  // Default concurrency: **unbounded** (`Infinity` — every branch runs
  // concurrently, clamped only by branch count). No rate-limit cap by default;
  // pass an explicit `concurrency` to throttle against provider limits.

  // With `onError`, any branch may be SKIPped → output values widen to
  // `BranchOutput | undefined`. The with-onError overloads are declared first
  // so they win when `onError` is present.

  /** Record-form + `onError`. Values are `BranchOutput | undefined` (SKIP-able). */
  parallel<TBranches extends Record<string, ParallelTarget<TContext, TOutput>>>(
    branches: TBranches & { [K in keyof TBranches]: GatelessBranch<TBranches[K]> },
    options: ParallelOptions<TContext, TOutput> & { onError: NonNullable<ParallelOptions<TContext, TOutput>["onError"]> },
  ): Workflow<TContext, TInput, ParallelOutputRecordPartial<TBranches>, TGates>;

  /** Record-form overload. Returns `{ [K]: BranchOutput<T[K]> }`. */
  parallel<TBranches extends Record<string, ParallelTarget<TContext, TOutput>>>(
    branches: TBranches & { [K in keyof TBranches]: GatelessBranch<TBranches[K]> },
    options?: ParallelOptions<TContext, TOutput>,
  ): Workflow<TContext, TInput, ParallelOutputRecord<TBranches>, TGates>;

  /** Tuple-form + `onError`. Each slot is `BranchOutput | undefined` (SKIP-able). */
  parallel<TBranches extends ReadonlyArray<ParallelTarget<TContext, TOutput>>>(
    branches: TBranches & { [K in keyof TBranches]: GatelessBranch<TBranches[K]> },
    options: ParallelOptions<TContext, TOutput> & { onError: NonNullable<ParallelOptions<TContext, TOutput>["onError"]> },
  ): Workflow<TContext, TInput, ParallelOutputTuplePartial<TBranches>, TGates>;

  /** Tuple-form overload. Returns `[O1, O2, ...]`. Use `as const`. */
  parallel<TBranches extends ReadonlyArray<ParallelTarget<TContext, TOutput>>>(
    branches: TBranches & { [K in keyof TBranches]: GatelessBranch<TBranches[K]> },
    options?: ParallelOptions<TContext, TOutput>,
  ): Workflow<TContext, TInput, ParallelOutputTuple<TBranches>, TGates>;

  // Implementation
  parallel(
    branches: Record<string, ParallelTarget<TContext, TOutput>> | ReadonlyArray<ParallelTarget<TContext, TOutput>>,
    options?: ParallelOptions<TContext, TOutput>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Workflow<TContext, TInput, any, TGates> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const node = new ParallelStep(branches as any, options as any, this.observability);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.appendStep<any>(node);
  }

  // ── repeat: conditional loop ─────────────────────────────────

  repeat<TG extends Record<string, unknown> = {}>(
    target: Agent<TContext, TOutput, TOutput> | (SealedWorkflow<TContext, TOutput, TOutput, TG> & NoGates<TG>),
    options: RepeatOptions<TContext, TOutput> & { id?: string },
  ): Workflow<TContext, TInput, TOutput, TGates> {
    if (options.maxIterations !== undefined && (!Number.isInteger(options.maxIterations) || options.maxIterations < 1)) {
      throw new Error(`repeat: maxIterations must be a positive integer, got ${options.maxIterations}`);
    }
    // The type union already enforces exactly-one; this guards a type-bypassed
    // caller (`{}` or both) from a confusing `options.while is not a function`
    // TypeError deep inside the loop body.
    if ((options.until === undefined) === (options.while === undefined)) {
      throw new Error("repeat: requires exactly one of `until` or `while`");
    }
    const maxIterations = options.maxIterations ?? 10;
    const isWorkflow = target instanceof SealedWorkflow;
    const defaultId = isWorkflow
      ? (target.id ?? "repeat")
      : `repeat:${(target as Agent<TContext, TOutput, TOutput>).id}`;
    const id = options.id ?? defaultId;
    const predicate: LoopPredicate<TContext, TOutput> = options.until
      ?? (async (p) => !(await options.while!(p)));

    const node = new RepeatStep(
      id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      target as Agent<any, any, any> | SealedWorkflow<any, any, any, any>,
      predicate,
      maxIterations,
      isWorkflow,
    );
    return this.appendStep<TOutput>(node);
  }

  // ── catch ─────────────────────────────────────────────────────

  catch(
    id: string,
    fn: (params: { error: unknown; ctx: Readonly<TContext>; lastOutput: TOutput; stepId: string }) => MaybePromise<TOutput>
  ): Workflow<TContext, TInput, TOutput, TGates> {
    // A preceding `gate` also qualifies — a throwing gate condition/payload is
    // routed as a `source: "step"` pendingError that `.catch()` is meant to handle.
    if (!this.steps.some(s => s.type === "step" || s.type === "gate")) {
      throw new Error(`Workflow: catch("${id}") requires at least one preceding step or gate.`);
    }
    const node = new CatchStep(
      id,
      fn as (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>,
    );
    return this.appendStep<TOutput>(node);
  }

  // `.finally()` is inherited from SealedWorkflow now (it lives there so
  // multi-finally chains are possible — `.finally().finally()`).
}
