// Public type / API surface for the workflow package. Extracted from
// workflow.ts to keep that file focused on the run-loop engine + builder.
// Type-only module (no runtime output); the cycle with ./workflow is safe.
import type { UIMessage, UIMessageStreamWriter, UIMessageStreamOnFinishCallback, IdGenerator, ToolSet } from "ai";
import type { Agent, GenerateTextResult, StreamTextResult, OutputType } from "./agent";
import type { MaybePromise } from "./utils";
import type { SealedWorkflow } from "./workflow";

// The `foreach`/`parallel` SKIP sentinel's type, referenced without importing
// the `Workflow` class value (a type-level dynamic import — fully erased, no
// runtime cycle through ./workflow).
type SkipSentinel = typeof import("./workflow").Workflow.SKIP;

// ── Snapshot / Warnings / Run options ────────────────────────────────

/**
 * v2 gate snapshot. The `kind` discriminant differentiates it from
 * checkpoint snapshots. The legacy v1 form is still accepted by `loadState`.
 */
export interface GateSnapshot {
  readonly version: 2;
  readonly kind: "gate";
  readonly resumeFromIndex: number;
  readonly output: unknown;
  readonly gateId: string;
  readonly gatePayload: unknown;
  /**
   * Path of nested-workflow step indices from the ROOT workflow down to the
   * workflow that owns the gate, outermost-first. Absent/empty for a top-level
   * gate. Each `.step(workflow)` the suspension bubbles through prepends its own
   * step index, so {@link SealedWorkflow.loadState} can descend back to the
   * gate on resume. (`resumeFromIndex` is the gate's index within that
   * innermost workflow; `gateId` is the innermost gate's id.)
   */
  readonly nestedPath?: readonly number[];
}

/**
 * v2 checkpoint snapshot. Carries a step-shape hash; resume verifies the
 * workflow definition hasn't drifted before continuing.
 */
export interface CheckpointSnapshot {
  readonly version: 2;
  readonly kind: "checkpoint";
  readonly resumeFromIndex: number;   // index of the NEXT step to run
  readonly output: unknown;
  readonly stepShapeHash: string;     // SHA-256 hex of canonical recursive shape
}

/**
 * Legacy v0.4.0 gate-only snapshot. Accepted by `loadState` for one release
 * via the shim path. `kind?: undefined` makes runtime narrowing on
 * `kind === undefined` reachable — JSON round-trips strip the property.
 * Migrate via `migrateSnapshot()` before v0.8.0+.
 */
export interface LegacyGateSnapshotV1 {
  readonly version: 1;
  readonly kind?: undefined;
  readonly resumeFromIndex: number;
  readonly output: unknown;
  readonly gateId: string;
  readonly gatePayload: unknown;
}

export type WorkflowSnapshot = GateSnapshot | CheckpointSnapshot | LegacyGateSnapshotV1;

export interface WorkflowWarning {
  readonly source:
    | "step"
    | "gate"
    | "finally"
    | "catch"
    | "onCheckpoint"
    | "onStepStart"
    | "onStepFinish"
    | "onStepError"
    | "onItemStart"
    | "onItemFinish"
    | "onItemError"
    | "foreach-sibling";
  readonly stepId: string;
  readonly error: unknown;
}

export type WorkflowStepType =
  | "step"
  | "nested"
  | "gate"
  | "catch"
  | "finally"
  | "branch"
  | "foreach"
  | "repeat"
  | "parallel";

/**
 * Workflow observability hooks. All optional. Errors thrown inside hooks
 * are captured into `result.warnings` with a matching `source` tag, except
 * `onStepError`, which causes the run to throw the ORIGINAL step error with
 * `error.cause = obsError` (preserving `instanceof` on the original).
 *
 * Per-node firing rules (where "step-like" = step / nested / branch /
 * foreach / parallel / repeat):
 *   - step-like / gate (cond-true → suspends): onStepStart always; onStepFinish
 *     when body returns (suspended: true for gate, false otherwise); onStepError
 *     on body throw.
 *   - step-like (`when` → false → skip): onStepStart, onStepFinish({ suspended:
 *     false }) with the passthrough/`otherwise` value as `output`. A skipped
 *     step's body never runs, but it is still bracketed by start/finish.
 *   - gate (cond false → skip): onStepStart, onStepFinish({ suspended: false }).
 *   - catch: onStepStart only when pendingError set; onStepFinish when catchFn
 *     returns; onStepError when catchFn throws.
 *   - finally: onStepStart always (runs even after suspension); onStepFinish
 *     always; onStepError when body throws.
 *   - foreach / parallel: emit ALSO per-item events (onItemStart/Finish/Error).
 *   - repeat: emit ONLY combinator-level events (no per-iteration events —
 *     iteration count is data-dependent and per-item would be misleading).
 *
 * Skip-checked nodes (`state.suspension || pendingError` already set on entry)
 * emit nothing — `.finally()` is the exception.
 */
export interface WorkflowObservability<TContext = unknown> {
  onStepStart?: (event: {
    stepId: string;
    type: WorkflowStepType;
    ctx: TContext;
    input: unknown;
  }) => MaybePromise<void>;
  onStepFinish?: (event: {
    stepId: string;
    type: WorkflowStepType;
    ctx: TContext;
    output: unknown;
    durationMs: number;
    suspended: boolean;
  }) => MaybePromise<void>;
  onStepError?: (event: {
    stepId: string;
    type: WorkflowStepType;
    ctx: TContext;
    error: unknown;
    durationMs: number;
  }) => MaybePromise<void>;
  onItemStart?: (event: {
    stepId: string;
    type: "foreach" | "parallel";
    itemIndex: number | string;
    ctx: TContext;
    input: unknown;
  }) => MaybePromise<void>;
  onItemFinish?: (event: {
    stepId: string;
    type: "foreach" | "parallel";
    itemIndex: number | string;
    ctx: TContext;
    output: unknown;
    durationMs: number;
  }) => MaybePromise<void>;
  onItemError?: (event: {
    stepId: string;
    type: "foreach" | "parallel";
    itemIndex: number | string;
    ctx: TContext;
    error: unknown;
    durationMs: number;
  }) => MaybePromise<void>;
}

export interface RunOptions {
  /**
   * Step-level checkpoint sink. Called after each successful step body when
   * `checkpointEvery` cadence or `checkpointWhen` predicate fires. Receives a
   * v2 `CheckpointSnapshot` and the run's `abortSignal` (or `undefined` when
   * the run wasn't given one), so a cancelled run can tear down an in-flight
   * write if the callback honors it. Throwing here propagates to the caller
   * as an error — workflow `.catch()` is bypassed for checkpoint failures.
   * There is no framework-imposed timeout; bound the write yourself by racing
   * the passed `signal` against your own timer if you need one.
   */
  readonly onCheckpoint?: (snapshot: CheckpointSnapshot, opts: { signal: AbortSignal | undefined }) => MaybePromise<void>;
  /**
   * Fire `onCheckpoint` every N executable steps. Mutually exclusive with
   * `checkpointWhen`. Default: `max(1, ceil(executableCount / 4))` —
   * 4 checkpoints across the run, with a floor of every step on tiny pipelines.
   */
  readonly checkpointEvery?: number;
  /**
   * Predicate variant — fire `onCheckpoint` exactly when this returns true.
   * Mutually exclusive with `checkpointEvery`.
   */
  readonly checkpointWhen?: (params: { stepIndex: number; stepId: string; ctx: unknown }) => boolean;
  /**
   * When truthy, deeply freeze the gate / checkpoint snapshot and the
   * `result.warnings` array. Default false. Pass `"iAcceptThePerformanceCost"`
   * to bypass `validateRunOptions`' catastrophic-combo guard
   * (freezeSnapshots: true + checkpointEvery: 1 + steps.length >= 8).
   */
  readonly freezeSnapshots?: boolean | "iAcceptThePerformanceCost";
  /**
   * Cooperative cancellation signal. Checked at every step boundary inside
   * `execute()` and forwarded to agent calls in `executeAgent`, foreach
   * workers, parallel branches, nested workflows, and the `onCheckpoint`
   * callback's `signal` (so a cancelled run can tear down an in-flight
   * checkpoint write, if the callback honors it). When the signal aborts,
   * the workflow tears down to `signal.reason` via the same pending-error path
   * as any other step failure, so `.catch()` handlers still get a chance to
   * observe the abort (e.g. for logging/cleanup) — but an abort is sticky and
   * non-recoverable: even a terminal `.catch()` that returns a value cannot
   * make the run complete; it still rejects with `signal.reason`. `.finally()`
   * bodies still run on the abort path. Unlike `freezeSnapshots`, this option DOES
   * propagate into nested workflows, foreach items, parallel branches, and
   * repeat loops — cancellation should be transitive.
   */
  readonly abortSignal?: AbortSignal;
}

// ── Shared Agent Step Hooks ─────────────────────────────────────────

/**
 * Discriminated union describing one agent invocation's result.
 *
 * - `mode: "generate"` — `result` is a `GenerateTextResult`; `.text`, `.output`,
 *   `.usage` etc. are synchronous (already-resolved).
 * - `mode: "stream"` — `result` is a `StreamTextResult`; the same fields are
 *   `Promise`s that you must `await` before reading.
 *
 * The shared field set (`ctx`, `input`) is identical across both modes;
 * narrowing on `mode` is only necessary when you need to touch a
 * mode-specific shape.
 */
export type AgentResultParams<TContext, TOutput, TNextOutput> =
  | {
      readonly mode: "generate";
      readonly result: GenerateTextResult<ToolSet, OutputType<TNextOutput>>;
      readonly ctx: Readonly<TContext>;
      readonly input: TOutput;
    }
  | {
      readonly mode: "stream";
      readonly result: StreamTextResult<ToolSet, OutputType<TNextOutput>>;
      readonly ctx: Readonly<TContext>;
      readonly input: TOutput;
    };

export interface AgentStepHooks<TContext, TOutput, TNextOutput> {
  /**
   * Transform the agent's result into the next step's input. Fires once per
   * step regardless of generate-vs-stream mode; discriminate on `mode` if you
   * need a mode-specific field. Returning the agent's `result.text` works
   * for both modes (string vs Promise<string>) because `MaybePromise` accepts
   * either.
   *
   * If omitted, the workflow's default extraction is used:
   *   - With `agent.output` declared → `extractOutput(result, agent.validateOutput)`
   *   - Without `agent.output` → `result.text` (awaited if stream)
   */
  mapResult?: (params: AgentResultParams<TContext, TOutput, TNextOutput>) => MaybePromise<TNextOutput>;

  /**
   * Observe the agent's result without changing the step's downstream value.
   * Fires once per step regardless of mode. Use for logging, telemetry,
   * usage accounting, side-effects that should not affect pipeline data
   * flow.
   */
  onResult?: (params: AgentResultParams<TContext, TOutput, TNextOutput>) => MaybePromise<void>;

  /**
   * **Stream-mode only.** Override the workflow's default
   * `writer.merge(result.toUIMessageStream())` call so YOU control how the
   * agent's stream reaches the outer workflow's UI message stream. Useful
   * for buffering, transforming, fan-out to multiple writers, or injecting
   * custom UI messages around the agent's output.
   *
   * Has no generate-mode analog because in generate mode there is no stream
   * to merge. If both `handleStream` and `mapResult`/`onResult` are
   * configured, `handleStream` runs first.
   *
   * `itemIndex` identifies the execution when this hook runs inside a
   * multi-execution combinator: the numeric index for `foreach` and tuple
   * `parallel`, the key for record `parallel`, and the matched key / case
   * index for `branch`. It is `undefined` for a plain single `.step(agent)`.
   */
  handleStream?: (params: {
    result: StreamTextResult<ToolSet, OutputType<TNextOutput>>;
    writer: UIMessageStreamWriter;
    ctx: Readonly<TContext>;
    input: TOutput;
    itemIndex?: number | string;
  }) => MaybePromise<void>;
}

// ── Step Options ────────────────────────────────────────────────────

/**
 * Predicate gating whether a step runs. Receives the step's input. When it
 * returns false the step is skipped — its body (agent / fn / sub-workflow) is
 * never invoked.
 */
export type StepWhen<TContext, TOutput> = (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;

/**
 * Produces the step's output when `when` returns false. With it, a skipped
 * step's output is `otherwise(...)` (typed `TNextOutput`, so the step's output
 * type stays `TNextOutput`). Without it, a skipped step passes its input
 * through unchanged (output type widens to `TOutput | TNextOutput`).
 */
export type StepOtherwise<TContext, TOutput, TNextOutput> = (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;

/** Conditional-skip options shared by all `step` forms. */
export interface ConditionalStepOptions<TContext, TOutput, TNextOutput> {
  /** Run the step only when this returns true. Omit to always run. */
  when?: StepWhen<TContext, TOutput>;
  /**
   * Skip value when `when` is false. Omit for passthrough (input unchanged).
   * Has no effect without `when` — a lone `otherwise` is never invoked.
   */
  otherwise?: StepOtherwise<TContext, TOutput, TNextOutput>;
}

export type StepOptions<TContext, TOutput, TNextOutput> =
  AgentStepHooks<TContext, TOutput, TNextOutput>
  & ConditionalStepOptions<TContext, TOutput, TNextOutput>
  & {
    /** Override the default step id (`agent.id`). Required when reusing the same
     *  agent across multiple steps in one workflow — the construction-time
     *  `(type, id)` walk rejects duplicates. */
    id?: string;
  };

/** Options for the inline `step(id, fn, options?)` form — conditional skip only. */
export type InlineStepOptions<TContext, TOutput, TNextOutput> = ConditionalStepOptions<TContext, TOutput, TNextOutput>;

/** Options for the nested `step(workflow, options?)` form — conditional skip + id override. */
export type NestedStepOptions<TContext, TOutput, TNextOutput> =
  ConditionalStepOptions<TContext, TOutput, TNextOutput> & { id?: string };

/**
 * A step that supplies `when` without `otherwise` may skip to passthrough, so
 * its output widens to `TOutput | TNextOutput`. Supplying `otherwise` (which
 * returns `TNextOutput`) — or omitting `when` — keeps the output `TNextOutput`.
 */
export type SkipPassthrough<TContext, TOutput, TNextOutput> =
  ConditionalStepOptions<TContext, TOutput, TNextOutput>
  & { when: StepWhen<TContext, TOutput>; otherwise?: undefined };

// ── Branch Types ────────────────────────────────────────────────────

export interface BranchCase<TContext, TOutput, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  when?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
  agent: Agent<TContext, TOutput, TNextOutput>;
}

export interface BranchSelect<TContext, TOutput, TKeys extends string, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  select: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TKeys>;
  agents: Record<TKeys, Agent<TContext, TOutput, TNextOutput>>;
  fallback?: Agent<TContext, TOutput, TNextOutput>;
  /**
   * Diagnostic hook invoked when `select` returns a key that has no matching
   * entry in `agents`. Fires BEFORE `fallback` is applied or
   * `WorkflowBranchError` is thrown, regardless of whether a `fallback` is
   * configured. Useful for logging typos / unexpected classifier output.
   */
  onUnknownKey?: (params: { key: string; availableKeys: TKeys[]; ctx: Readonly<TContext> }) => void;
}

// ── Result Types ────────────────────────────────────────────────────

export type WorkflowResult<TOutput> =
  | { readonly status: "complete"; readonly output: TOutput; readonly warnings: readonly WorkflowWarning[] }
  | { readonly status: "suspended"; readonly snapshot: GateSnapshot; readonly warnings: readonly WorkflowWarning[] };

export interface WorkflowStreamResult<TOutput> {
  stream: ReadableStream;
  output: Promise<WorkflowResult<TOutput>>;   // never rejects on suspension; rejects on real errors
}

/**
 * Options for `Workflow.stream` / `ResumedWorkflow.stream` /
 * `CheckpointResumedWorkflow.stream`. Forwarded verbatim to the AI SDK's
 * `createUIMessageStream`.
 *
 * Generic over the UI message shape so consumers with a custom
 * `UIMessage<METADATA, DATA_PARTS, TOOLS>` get their narrowed type in
 * `onFinish` / `originalMessages` instead of the unparameterized default.
 *
 * Note: AI SDK's `createUIMessageStream` ALSO accepts an `onStepFinish`
 * (per-token-step) callback. We intentionally do NOT expose it here — there
 * are already two clearer step-finish callbacks at different granularities:
 * - `Agent.onStepFinish` for per-model-call observation, and
 * - `WorkflowObservability.onStepFinish` for per-workflow-step observation.
 * Adding a third one named the same thing on `WorkflowStreamOptions` would
 * be confusing. Reach for one of the two above instead.
 */
export interface WorkflowStreamOptions<UI_MESSAGE extends UIMessage = UIMessage> {
  /**
   * Map an unknown error into a user-visible string. Forwarded as-is to
   * `createUIMessageStream`'s `onError`. Returning `string` is required by
   * the AI SDK — the string is what the stream emits to clients.
   */
  onError?: (error: unknown) => string;
  /**
   * Prior `UIMessage`s the stream should continue from. When provided, the
   * AI SDK assumes persistence mode and assigns a response-message id.
   * Used for chat resumption / continuation flows.
   */
  originalMessages?: UI_MESSAGE[];
  /**
   * Fires once the stream finishes, with the full payload the AI SDK
   * delivers: the updated `messages` array, the freshly-emitted
   * `responseMessage`, `isAborted` / `isContinuation` flags, and the
   * `finishReason`. Use this for persistence, analytics, or downstream
   * notification.
   */
  onFinish?: UIMessageStreamOnFinishCallback<UI_MESSAGE>;
  /**
   * Override the response message-id generator. Forwarded to
   * `createUIMessageStream`'s `generateId` option. Useful for deterministic
   * IDs in tests or coordinating with a server-side ID space.
   */
  generateId?: IdGenerator;
}

// ── Loop Types ──────────────────────────────────────────────────────

export type LoopPredicate<TContext, TOutput> = (params: {
  output: TOutput;
  ctx: Readonly<TContext>;
  iterations: number;
}) => MaybePromise<boolean>;

/**
 * Loop control for `repeat`. Exactly one of `until` / `while` — never both.
 *
 * Both forms are **do-while**: the body always runs at least once, then the
 * predicate is checked. This is intentional — the predicate receives the
 * body's `output`, which doesn't exist until the body has run — but it means
 * `while: () => false` still executes the body once (it is not a pre-check).
 */
export type RepeatOptions<TContext, TOutput> =
  | { until: LoopPredicate<TContext, TOutput>; while?: never; maxIterations?: number }
  | { while: LoopPredicate<TContext, TOutput>; until?: never; maxIterations?: number };

// Extracts the element type from an array type. Resolves to `never` for non-arrays,
// making foreach uncallable at compile time when the previous step doesn't produce an array.
export type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

/**
 * Brand that makes a *gated* workflow unassignable where gates are forbidden —
 * `foreach` / `parallel` / `repeat` targets. A nested gate can't suspend one
 * branch of a concurrent fan-out or one iteration of a loop, so it's rejected
 * at build time. Since `.step(workflow)` folds child gates into `TGates`, this
 * catches gates at ANY nesting depth, not just direct ones.
 */
export type GatesForbidden = {
  readonly __agent_workflow_error__: "a workflow with gate(s) cannot be a foreach / parallel / repeat target";
};

/** `unknown` when `TG` has no gate keys (no-op intersection), else the {@link GatesForbidden} brand. */
export type NoGates<TG extends Record<string, unknown>> = [keyof TG] extends [never] ? unknown : GatesForbidden;

/** A `parallel` branch with its gates checked: gated workflows resolve to the {@link GatesForbidden} brand. */
export type GatelessBranch<T> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  T extends SealedWorkflow<any, any, any, infer G>
    ? ([keyof G] extends [never] ? T : GatesForbidden)
    : T;

// ── parallel() supporting types ─────────────────────────────────────

/** A target for a `parallel()` branch — agent or sealed workflow. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ParallelTarget<TContext, TInput> =
  | Agent<TContext, TInput, any>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  | SealedWorkflow<TContext, TInput, any>;

/** Extract the output type of a single parallel branch target. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type BranchOutput<T> = T extends Agent<any, any, infer O>
  ? O
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : T extends SealedWorkflow<any, any, infer O>
  ? O
  : never;

/** Output shape for the record form: `{ [K]: BranchOutput<T[K]> }`. */
export type ParallelOutputRecord<T extends Record<string, unknown>> = {
  [K in keyof T]: BranchOutput<T[K]>;
};

/** Output shape for the tuple form: `[O1, O2, ...]`. */
export type ParallelOutputTuple<T extends ReadonlyArray<unknown>> = {
  [K in keyof T]: BranchOutput<T[K]>;
};

/**
 * Record output when `onError` is supplied: any branch may be `SKIP`ped,
 * leaving its slot `undefined`, so every value is widened to `| undefined`.
 */
export type ParallelOutputRecordPartial<T extends Record<string, unknown>> = {
  [K in keyof T]: BranchOutput<T[K]> | undefined;
};

/** Tuple counterpart of `ParallelOutputRecordPartial` — each slot `| undefined`. */
export type ParallelOutputTuplePartial<T extends ReadonlyArray<unknown>> = {
  [K in keyof T]: BranchOutput<T[K]> | undefined;
};

export interface ParallelOptions<TContext, TOutput = unknown> {
  /** Override the default step id. Default: `parallel:record` or `parallel:tuple`. */
  id?: string;
  /**
   * Max branches in flight at any moment. **Default: unbounded** (`Infinity` —
   * all branches run concurrently, clamped only by branch count). Pass an
   * integer to throttle against provider rate limits.
   */
  concurrency?: number;
  /**
   * Per-branch error handler. On the no-suspension path, called once per
   * rejected branch in index order after all settle. Return a value to
   * substitute, return `Workflow.SKIP` to leave the slot `undefined`, or
   * rethrow to abort the parallel. A throw (or rethrow) aborts immediately:
   * rejected branches at indices AFTER the throwing one are neither recovered
   * nor surfaced as warnings. SKIP works in both the record and tuple
   * forms (the slot stays `undefined` in place — it does not shift indices);
   * supplying `onError` widens the output values to `BranchOutput | undefined`
   * to reflect that a slot may be skipped.
   *
   * **Bypassed entirely on the suspension path** (any branch hit a nested
   * gate) and on the cancellation path (the run was aborted). See README's
   * "Suspension under `parallel()`" section.
   */
  onError?: (params: {
    error: unknown;
    /** Branch key in the record form; `undefined` in the tuple form. */
    key?: string;
    /** Branch index in the tuple form; `undefined` in the record form. */
    index?: number;
    ctx: Readonly<TContext>;
  }) => unknown | SkipSentinel | Promise<unknown | SkipSentinel>;
  /**
   * **Stream-mode + agent-branch only.** When the workflow is run via
   * `.stream(...)`, each agent branch runs in stream mode and this hook decides
   * how its stream surfaces to the writer (`itemIndex` = the record key or the
   * tuple index). Without it, agent branches run in generate mode (no
   * auto-merge). Not invoked for `SealedWorkflow` branches (which stream
   * transitively via their own steps) nor in generate mode.
   */
  handleStream?: (params: {
    // Branch output types vary across the record/tuple, so the result is loosely
    // typed here — narrow inside the handler if needed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    result: StreamTextResult<ToolSet, any>;
    writer: UIMessageStreamWriter;
    ctx: Readonly<TContext>;
    input: TOutput;
    itemIndex: number | string;
  }) => MaybePromise<void>;
}

// ── Schema type (structural — works with Zod, Valibot, ArkType, etc.) ──

export interface SchemaWithParse<T = unknown> {
  parse(data: unknown): T;
}
