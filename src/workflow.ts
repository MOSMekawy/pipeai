import {
  createUIMessageStream,
  type UIMessage,
  type UIMessageStreamWriter,
  type UIMessageStreamOnFinishCallback,
  type IdGenerator,
  type ToolSet,
} from "ai";
import { type Agent, type GenerateTextResult, type StreamTextResult, type OutputType } from "./agent";
import { computeStepShapeHash, deepFreeze, extractOutput, runWithWriter, warnOnce, type MaybePromise } from "./utils";

// ── Error Types ─────────────────────────────────────────────────────

export class WorkflowBranchError extends Error {
  constructor(
    public readonly branchType: "predicate" | "select",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowBranchError";
  }
}

export class WorkflowLoopError extends Error {
  constructor(
    public readonly iterations: number,
    public readonly maxIterations: number,
  ) {
    super(`Loop exceeded maximum iterations (${maxIterations})`);
    this.name = "WorkflowLoopError";
  }
}

export class NestedGateUnsupportedError extends Error {
  readonly gateId: string;
  readonly workflowId: string | undefined;
  // Always present; non-gate rejections from concurrent foreach.
  readonly siblingErrors: readonly unknown[];
  // Always present; OTHER suspending items in concurrent foreach.
  readonly siblingSuspensions: readonly { index: number; gateId: string }[];

  constructor(
    gateId: string,
    workflowId: string | undefined,
    siblingErrors: readonly unknown[] = [],
    siblingSuspensions: readonly { index: number; gateId: string }[] = [],
  ) {
    super(`Gate "${gateId}" hit inside nested workflow "${workflowId ?? "(anonymous)"}". Nested gates are not yet supported.`);
    this.name = "NestedGateUnsupportedError";
    this.gateId = gateId;
    this.workflowId = workflowId;
    this.siblingErrors = siblingErrors;
    this.siblingSuspensions = siblingSuspensions;
  }
}

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
    | "finally"
    | "catch"
    | "onCheckpoint"
    | "onStepStart"
    | "onStepFinish"
    | "onStepError"
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
   * v2 `CheckpointSnapshot` and an `AbortSignal` that aborts on
   * `checkpointTimeout` expiration. Throwing here propagates to the caller
   * as an error — workflow `.catch()` is bypassed for checkpoint failures.
   */
  readonly onCheckpoint?: (snapshot: CheckpointSnapshot, opts: { signal: AbortSignal }) => MaybePromise<void>;
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
   * workers, and nested workflows. When the signal aborts, the workflow
   * tears down to `signal.reason` via the same pending-error path as any
   * other step failure, so `.catch()` handlers still get a chance to
   * observe (or recover from) the abort. `.finally()` bodies still run
   * on the abort path. Unlike `freezeSnapshots`, this option DOES
   * propagate into nested workflows, foreach items, and repeat loops —
   * cancellation should be transitive.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Maximum ms `onCheckpoint` is allowed to run before its AbortSignal fires.
   * On timeout, a `CheckpointTimeoutError` is raised on the run (catch is
   * bypassed; original error reaches the caller). Default: no timeout.
   */
  readonly checkpointTimeout?: number;
}

/**
 * Synthetic step id reported when `onCheckpoint` itself throws. Reserved
 * via the construction-time `(type, id)` walk — user step ids may not
 * contain the `::pipeai::` namespace.
 */
export const CHECKPOINT_STEP_ID = "::pipeai::onCheckpoint" as const;

/**
 * Thrown internally when `onCheckpoint` exceeds `RunOptions.checkpointTimeout`.
 * Surfaces to the caller as the rejection error.
 */
export class CheckpointTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super(`onCheckpoint exceeded ${timeoutMs}ms timeout`);
    this.name = "CheckpointTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

function resolveFreezeSnapshots(state: RuntimeState): boolean {
  return state.runOptions?.freezeSnapshots ? true : false;
}

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
   */
  handleStream?: (params: {
    result: StreamTextResult<ToolSet, OutputType<TNextOutput>>;
    writer: UIMessageStreamWriter;
    ctx: Readonly<TContext>;
    input: TOutput;
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
type SkipPassthrough<TContext, TOutput, TNextOutput> =
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

type LoopPredicate<TContext, TOutput> = (params: {
  output: TOutput;
  ctx: Readonly<TContext>;
  iterations: number;
}) => MaybePromise<boolean>;

// Exactly one of `until` or `while` — never both.
export type RepeatOptions<TContext, TOutput> =
  | { until: LoopPredicate<TContext, TOutput>; while?: never; maxIterations?: number }
  | { while: LoopPredicate<TContext, TOutput>; until?: never; maxIterations?: number };

// Extracts the element type from an array type. Resolves to `never` for non-arrays,
// making foreach uncallable at compile time when the previous step doesn't produce an array.
type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

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

export interface ParallelOptions<TContext> {
  /** Override the default step id. Default: `parallel:record` or `parallel:tuple`. */
  id?: string;
  /**
   * Max branches in flight at any moment. Default: `min(branches.length, 5)`.
   * Pass `Infinity` (or `branches.length`) for full fan-out on >5-branch calls
   * — the default caps at 5 to protect against rate limits and emits a
   * one-time warn when the cap kicks in.
   */
  concurrency?: number;
  /**
   * Per-branch error handler. On the no-suspension path, called once per
   * rejected branch in index order after all settle. Return a value to
   * substitute, return `Workflow.SKIP` to leave the slot undefined (record
   * form only — tuple SKIP would shift indices), or rethrow to abort the
   * parallel.
   *
   * **Bypassed entirely on the suspension path** (any branch hit a nested
   * gate). See README's "Suspension under `parallel()`" section.
   */
  onError?: (params: {
    error: unknown;
    /** Branch key in the record form; `undefined` in the tuple form. */
    key?: string;
    /** Branch index in the tuple form; `undefined` in the record form. */
    index?: number;
    ctx: Readonly<TContext>;
  }) => unknown | typeof Workflow.SKIP | Promise<unknown | typeof Workflow.SKIP>;
}

// ── Schema type (structural — works with Zod, Valibot, ArkType, etc.) ──

interface SchemaWithParse<T = unknown> {
  parse(data: unknown): T;
}

// ── Step Node ───────────────────────────────────────────────────────

// `nestedWorkflow` is consumed by the recursive `stepShapeHash` walk; runtime
// execution goes through the `execute` closure. `category` drives
// observability event typing — keeps a single `type: "step"` variant rather
// than splitting branch/foreach/repeat/parallel/nested into their own unions.
type StepCategory = "step" | "nested" | "branch" | "foreach" | "repeat" | "parallel";

type StepNode =
  | {
      readonly type: "step";
      readonly id: string;
      readonly execute: (state: RuntimeState) => MaybePromise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;
      /** Disambiguates observability events. Default `"step"`. */
      readonly category?: StepCategory;
    }
  | { readonly type: "catch"; readonly id: string; readonly catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown> }
  | { readonly type: "finally"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> }
  | { readonly type: "gate"; readonly id: string; readonly payload: (state: RuntimeState) => MaybePromise<unknown>; readonly schema?: SchemaWithParse; readonly condition?: (state: RuntimeState) => MaybePromise<boolean>; readonly merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown> };

/**
 * Maps a step node's category (or non-step type) to the observability event
 * `type` field. Drives `WorkflowStepType` reporting.
 */
function getObservabilityType(node: StepNode): WorkflowStepType {
  if (node.type !== "step") return node.type;
  return (node.category ?? "step") as WorkflowStepType;
}

/**
 * Returns the nested workflow(s) attached to a step node. The exhaustive
 * switch (no `default`) makes adding a new StepNode variant a TS error.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNestedWorkflows(node: StepNode): readonly SealedWorkflow<any, any, any, any>[] {
  switch (node.type) {
    case "step": return node.nestedWorkflow ? [node.nestedWorkflow] : [];
    case "gate":
    case "catch":
    case "finally": return [];
  }
}

interface RuntimeState {
  ctx: unknown;
  output: unknown;
  mode: "generate" | "stream";
  writer?: UIMessageStreamWriter;
  // Only gates set `suspension`.
  suspension?: GateSnapshot;
  warnings?: WorkflowWarning[];
  checkpointFailed?: boolean;
  // Same RunOptions seen by execute(); reset to undefined inside nested
  // workflows and omitted from foreach itemState so per-run config doesn't
  // leak into nested execution.
  runOptions?: RunOptions;
  // Cooperative cancellation. Held on state separately from runOptions
  // because — unlike freezeSnapshots — abortSignal SHOULD propagate into
  // nested workflows and foreach items.
  abortSignal?: AbortSignal;
}

// Pending error tracked through a single execute() pass. The `source`
// discriminant drives the precedence tail
// (checkpointFailed > finally-wrap > step > suspension) and the onStepError
// type mapping below.
type PendingError = {
  error: unknown;
  stepId: string;
  source: "step" | "finally" | "catch" | "onCheckpoint";
};

/**
 * Map `PendingError.source` to the `WorkflowStepType` value that
 * `onStepError` should report. `onCheckpoint` is mapped to `"step"`,
 * consistent with the `{ stepId: CHECKPOINT_STEP_ID, type: "step" }` contract.
 * Exhaustive switch — adding a new `source` variant is a compile error.
 */
function pendingErrorSourceToStepType(source: PendingError["source"]): WorkflowStepType {
  switch (source) {
    case "step": return "step";
    case "finally": return "finally";
    case "catch": return "catch";
    case "onCheckpoint": return "step";
  }
}

/**
 * Invoke `opts.onCheckpoint(snapshot, { signal })` with optional timeout via
 * AbortSignal. Throws on onCheckpoint failure or timeout
 * (CheckpointTimeoutError). The run loop catches and sets
 * `state.checkpointFailed`, which routes through the precedence tail
 * (checkpointFailed > finally-wrap > original-step > suspension).
 */
async function emitCheckpoint(
  state: RuntimeState,
  opts: RunOptions,
  resumeFromIndex: number,
  stepShapeHash: string,
): Promise<void> {
  if (!opts.onCheckpoint) return;
  const snap: CheckpointSnapshot = {
    version: 2,
    kind: "checkpoint",
    resumeFromIndex,
    output: state.output,
    stepShapeHash,
  };
  if (resolveFreezeSnapshots(state)) deepFreeze(snap);

  const controller = new AbortController();
  if (opts.checkpointTimeout !== undefined) {
    const timeoutMs = opts.checkpointTimeout;
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const callPromise = Promise.resolve(opts.onCheckpoint(snap, { signal: controller.signal }));
      const timeoutPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener(
          "abort",
          () => reject(new CheckpointTimeoutError(timeoutMs)),
          { once: true },
        );
      });
      // Swallow loser to avoid unhandled rejection on the race.
      callPromise.catch(() => {});
      timeoutPromise.catch(() => {});
      await Promise.race([callPromise, timeoutPromise]);
    } finally {
      clearTimeout(timeoutId);
    }
  } else {
    await opts.onCheckpoint(snap, { signal: controller.signal });
  }
}

// One-time stream-mode warning when a gate fires with options.onError set.
let warnedStreamOnErrorOnSuspend = false;

/**
 * @internal — test-only reset of the one-time stream-mode warn dedup.
 */
export function __resetStreamOnErrorOnSuspendWarnForTests(): void {
  warnedStreamOnErrorOnSuspend = false;
}

/**
 * Push an entry onto state.warnings, allocating the array lazily on first use.
 * Centralizes the `(state.warnings ??= []).push({source, stepId, error})` idiom.
 */
function pushWarning(
  state: RuntimeState,
  source: WorkflowWarning["source"],
  stepId: string,
  error: unknown,
): void {
  (state.warnings ??= []).push({ source, stepId, error });
}

/**
 * Demote a pendingError into a warning. Used everywhere a new pendingError is
 * about to overwrite the prior one (finally/catch errors after a step error,
 * abort promoted over an in-flight error, suspension-wins tail).
 */
function demotePendingError(state: RuntimeState, pe: PendingError): void {
  pushWarning(state, pe.source, pe.stepId, pe.error);
}

/**
 * Emit the one-shot stream-onError-on-suspend warning if applicable.
 */
function maybeWarnStreamOnErrorOnSuspend(
  result: WorkflowResult<unknown>,
  options: { onError?: (error: unknown) => string } | undefined,
): void {
  if (result.status !== "suspended" || !options?.onError || warnedStreamOnErrorOnSuspend) return;
  warnedStreamOnErrorOnSuspend = true;
  console.warn(
    "pipeai: stream() with options.onError suspended at a gate — onError will NOT be invoked for suspension. Discriminate via the resolved output Promise."
  );
}

// ── Sealed Workflow (returned by finally — execution only) ───────────

export class SealedWorkflow<
  TContext,
  TInput = void,
  TOutput = void,
  TGates extends Record<string, unknown> = {},
> {
  readonly id?: string;
  protected readonly steps: ReadonlyArray<StepNode>;
  protected readonly observability?: WorkflowObservability;
  // Memoized — see ensureDuplicateCheck().
  private duplicateCheckPassed = false;
  // Memoized lazily per terminal instance — build pipelines once at module
  // load and re-run via generate() to amortize.
  private _cachedExecutableStepCount?: number;
  private _cachedStepShapeHash?: string;

  protected constructor(steps: ReadonlyArray<StepNode>, id?: string, observability?: WorkflowObservability) {
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

  // ── shape-hash + RunOptions validation ────────────────────────

  /**
   * Count of executable nodes — i.e. NOT `catch` or `finally`. Drives
   * checkpoint auto-cadence so adding cleanup steps doesn't surprise users
   * with extra fires. `branch`/`foreach`/`repeat`/`parallel`/`nested` are all
   * `type: "step"` internally and count as executable.
   */
  protected get cachedExecutableStepCount(): number {
    if (this._cachedExecutableStepCount !== undefined) return this._cachedExecutableStepCount;
    let n = 0;
    for (const s of this.steps) {
      if (s.type !== "catch" && s.type !== "finally") n++;
    }
    this._cachedExecutableStepCount = n;
    return n;
  }

  /** @internal — used by `computeStepShapeHash` to descend nested workflows. */
  getStepsForShapeHash(): ReadonlyArray<StepNode> {
    return this.steps;
  }

  protected get cachedStepShapeHash(): string {
    if (this._cachedStepShapeHash !== undefined) return this._cachedStepShapeHash;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const getNested = (node: any) => getNestedWorkflows(node as StepNode) as unknown as readonly { id?: string; getStepsForShapeHash(): ReadonlyArray<{ type: string; id: string }> }[];
    this._cachedStepShapeHash = computeStepShapeHash(
      this.steps as unknown as ReadonlyArray<{ type: string; id: string }>,
      getNested,
    );
    return this._cachedStepShapeHash;
  }

  /**
   * Validate user-provided RunOptions before a run begins. Throws on
   * outright errors and on the loud-disaster combo (`freezeSnapshots: true
   * + checkpointEvery: 1` on a workflow of 8+ steps). Warns once on the
   * merely-suspicious combo (`freezeSnapshots: true + cadence <= 2`).
   * Plan-of-record: catastrophic combo escape via the
   * `"iAcceptThePerformanceCost"` literal.
   */
  protected validateRunOptions(opts: RunOptions | undefined): void {
    if (!opts) return;
    // checkpoint-specific validation only applies when onCheckpoint is set.
    if (!opts.onCheckpoint) return;
    if (opts.checkpointEvery !== undefined && opts.checkpointWhen !== undefined) {
      throw new Error("RunOptions: checkpointEvery and checkpointWhen are mutually exclusive");
    }
    if (opts.checkpointEvery !== undefined && (!Number.isInteger(opts.checkpointEvery) || opts.checkpointEvery < 1)) {
      throw new Error(`RunOptions: checkpointEvery must be a positive integer, got ${opts.checkpointEvery}`);
    }
    if (opts.checkpointTimeout !== undefined && (!Number.isFinite(opts.checkpointTimeout) || opts.checkpointTimeout < 1)) {
      throw new Error(`RunOptions: checkpointTimeout must be a finite positive number (ms), got ${opts.checkpointTimeout}`);
    }
    const length = this.cachedExecutableStepCount;
    const cadence = opts.checkpointEvery ?? Math.max(1, Math.ceil(length / 4));
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
   */
  protected fireHook<
    K extends keyof WorkflowObservability,
    E extends Parameters<NonNullable<WorkflowObservability[K]>>[0],
  >(
    state: RuntimeState,
    name: K,
    event: E,
  ): MaybePromise<unknown> {
    const hook = this.observability?.[name];
    if (!hook) return undefined;
    return this.fireHookSlow(state, name, event, hook);
  }

  private async fireHookSlow<K extends keyof WorkflowObservability>(
    state: RuntimeState,
    name: K,
    event: unknown,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    hook: any,
  ): Promise<unknown> {
    try {
      await hook(event);
      return undefined;
    } catch (e) {
      if (name !== "onStepError") {
        const stepId = (event as { stepId: string }).stepId;
        pushWarning(state, name as WorkflowWarning["source"], stepId, e);
        // eslint-disable-next-line no-console
        console.error(`pipeai: ${name} hook threw for stepId "${stepId}":`, e);
      }
      return e;
    }
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
    this.validateRunOptions(opts);
    const state: RuntimeState = {
      ctx,
      output: input,
      mode: "generate",
      runOptions: opts,
      abortSignal: opts?.abortSignal,
    };

    await this.execute(state, 0, opts);

    return this.buildResult(state);
  }

  stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
      : [input: TInput, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput> {
    this.ensureDuplicateCheck();
    const input = args[0];
    const options = args[1] as WorkflowStreamOptions<UI_MESSAGE> | undefined;
    const opts = args[2] as RunOptions | undefined;
    this.validateRunOptions(opts);
    const abortSignal = opts?.abortSignal;

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
        const state: RuntimeState = {
          ctx,
          output: input,
          mode: "stream",
          writer,
          runOptions: opts,
          abortSignal,
        };

        try {
          await this.execute(state, 0, opts);
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

    return {
      stream,
      output: outputPromise,
    };
  }

  // Helper — converts terminal RuntimeState into a WorkflowResult; freezes
  // snapshot + warnings if requested via runOptions.
  protected buildResult(state: RuntimeState): WorkflowResult<TOutput> {
    const warnings = state.warnings ?? [];
    if (state.suspension && resolveFreezeSnapshots(state)) {
      deepFreeze(warnings);
    }
    if (state.suspension) {
      return { status: "suspended", snapshot: state.suspension, warnings };
    }
    return { status: "complete", output: state.output as TOutput, warnings };
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
      ? (opts.checkpointEvery ?? Math.max(1, Math.ceil(this.cachedExecutableStepCount / 4)))
      : 0;

    // `initialError` lets callers (e.g. ResumedWorkflow.stream) seed the
    // pipeline already-in-error so a pre-execute failure (schema.parse,
    // merge throw) flows through downstream `.catch()` like any other step
    // failure instead of escaping synchronously.
    let pendingError: PendingError | null = initialError;

    // Tracks whether the abort signal has already been promoted into
    // pendingError in this execute() pass. On first observation we discard
    // any in-progress suspension (caller asked to stop) and preserve any
    // prior step error as a warning. Subsequent iterations only re-promote
    // if a downstream catch cleared pendingError — the platform semantics
    // of AbortSignal.aborted (sticky once true) say the workflow shouldn't
    // resume mid-pipeline just because a catch swallowed one observation.
    let abortPromoted = false;
    const makeAbortError = (signal: AbortSignal): PendingError => ({
      error: signal.reason ?? new Error("Workflow aborted"),
      stepId: "abort",
      source: "step",
    });

    for (let i = startIndex; i < this.steps.length; i++) {
      // Abort checkpoint — runs at every iteration boundary, before any
      // node dispatch, so finally/catch nodes that come AFTER the abort
      // still get to run (cleanup + recovery contract).
      if (state.abortSignal?.aborted) {
        if (!abortPromoted) {
          abortPromoted = true;
          state.suspension = undefined;
          if (pendingError) demotePendingError(state, pendingError);
          pendingError = makeAbortError(state.abortSignal);
        } else if (!pendingError) {
          // A catch handler swallowed the abort. Re-promote so downstream
          // steps still see the signal as the "stop" condition the caller
          // requested.
          pendingError = makeAbortError(state.abortSignal);
        }
      }

      const node = this.steps[i];

      if (node.type === "finally") {
        const stepId = node.id;
        const finStart = performance.now();
        await this.fireHook(state, "onStepStart", { stepId, type: "finally", ctx: state.ctx, input: state.output });
        try {
          await node.execute(state);
          await this.fireHook(state, "onStepFinish", {
            stepId, type: "finally", ctx: state.ctx, output: state.output,
            durationMs: performance.now() - finStart, suspended: false,
          });
        } catch (e) {
          await this.fireHook(state, "onStepError", {
            stepId, type: "finally", ctx: state.ctx, error: e,
            durationMs: performance.now() - finStart,
          });
          // Multi-error preservation: never silently overwrite a prior pendingError —
          // push it to warnings before promoting this finally error.
          if (pendingError) demotePendingError(state, pendingError);
          pendingError = { error: e, stepId, source: "finally" };
        }
        continue;
      }

      if (node.type === "catch") {
        // .catch() bypassed on suspension AND on checkpoint failure (checkpoint failure propagates to caller).
        if (state.suspension || !pendingError || state.checkpointFailed) continue;
        const stepId = node.id;
        const cStart = performance.now();
        await this.fireHook(state, "onStepStart", { stepId, type: "catch", ctx: state.ctx, input: state.output });
        try {
          state.output = await node.catchFn({
            error: pendingError.error,
            ctx: state.ctx,
            lastOutput: state.output,
            stepId: pendingError.stepId,
          });
          pendingError = null;
          await this.fireHook(state, "onStepFinish", {
            stepId, type: "catch", ctx: state.ctx, output: state.output,
            durationMs: performance.now() - cStart, suspended: false,
          });
        } catch (e) {
          await this.fireHook(state, "onStepError", {
            stepId, type: "catch", ctx: state.ctx, error: e,
            durationMs: performance.now() - cStart,
          });
          if (pendingError) demotePendingError(state, pendingError);
          pendingError = { error: e, stepId, source: "catch" };
        }
        continue;
      }

      // Skip remaining non-finally/non-catch nodes when suspended or in error state.
      if (state.suspension || pendingError) continue;

      if (node.type === "gate") {
        // Capture errors from condition/payload callbacks into pendingError so
        // they route through the workflow's .catch() pipeline like any other
        // step error. Without this, a throwing gate callback escapes execute()
        // entirely and bypasses all downstream catch nodes.
        const stepId = node.id;
        const gStart = performance.now();
        await this.fireHook(state, "onStepStart", { stepId, type: "gate", ctx: state.ctx, input: state.output });
        try {
          if (node.condition && !(await node.condition(state))) {
            // Cond returned false — skip the gate. Fire onStepFinish({ suspended: false }).
            await this.fireHook(state, "onStepFinish", {
              stepId, type: "gate", ctx: state.ctx, output: state.output,
              durationMs: performance.now() - gStart, suspended: false,
            });
            continue;
          }
          const snapshot: GateSnapshot = {
            version: 2,
            kind: "gate",
            resumeFromIndex: i,
            output: state.output,
            gateId: node.id,
            gatePayload: await node.payload(state),
          };
          state.suspension = snapshot;
          if (resolveFreezeSnapshots(state)) deepFreeze(snapshot);
          await this.fireHook(state, "onStepFinish", {
            stepId, type: "gate", ctx: state.ctx, output: state.output,
            durationMs: performance.now() - gStart, suspended: true,
          });
        } catch (e) {
          pendingError = { error: e, stepId: node.id, source: "step" };
        }
        continue;
      }

      // type === "step" — driven by `category` for observability type reporting.
      const obsType = getObservabilityType(node);
      const stepId = node.id;
      const sStart = performance.now();
      const stepInput = state.output;
      await this.fireHook(state, "onStepStart", { stepId, type: obsType, ctx: state.ctx, input: stepInput });
      try {
        await node.execute(state);
        await this.fireHook(state, "onStepFinish", {
          stepId, type: obsType, ctx: state.ctx, output: state.output,
          durationMs: performance.now() - sStart, suspended: false,
        });
      } catch (e) {
        pendingError = { error: e, stepId: node.id, source: "step" };
        // onStepError special-cases: if the hook throws, attach the obsError as
        // `cause` on the original step error so the original reaches the caller
        // with the failure trail attached. Other hooks' throws become warnings.
        const obsError = await this.fireHook(state, "onStepError", {
          stepId, type: obsType, ctx: state.ctx, error: e,
          durationMs: performance.now() - sStart,
        });
        if (obsError !== undefined && typeof e === "object" && e !== null) {
          try {
            (e as { cause?: unknown }).cause = obsError;
          } catch {
            // Some objects are frozen / non-extensible — ignore.
          }
        }
      }

      // Defensive invariant: only gate nodes set state.suspension, and
      // executeNestedWorkflow/foreach clear inner suspension before rethrowing.
      // A non-undefined value here means a coding bug bypassed that contract.
      // The cast is needed because TS narrowed suspension to undefined at the
      // top-of-loop falsy check and doesn't know the await may have mutated it.
      const leaked = (state as { suspension?: GateSnapshot }).suspension;
      if (leaked) {
        state.suspension = undefined;
        throw new Error(`internal: suspension bubbled from non-gate step "${node.id}" (gate "${leaked.gateId}").`);
      }

      // Emit a checkpoint after a successful step body. Skipped on pendingError
      // (the step threw — no clean state to snapshot) or on suspension (gate
      // already won). Numeric `checkpointEvery` (default: max(1, ceil(count/4)))
      // uses the loop-hoisted `ckptCadence`; predicate form runs per step.
      if (!pendingError && !state.suspension && opts?.onCheckpoint) {
        const shouldCheckpoint = opts.checkpointWhen
          ? opts.checkpointWhen({ stepIndex: i, stepId: node.id, ctx: state.ctx })
          : (i + 1) % ckptCadence === 0;
        if (shouldCheckpoint) {
          const ckptStart = performance.now();
          try {
            await emitCheckpoint(
              state,
              opts,
              i + 1,
              this.cachedStepShapeHash,
            );
          } catch (e) {
            pendingError = { error: e, stepId: CHECKPOINT_STEP_ID, source: "onCheckpoint" };
            state.checkpointFailed = true;
            // Route through onStepError with the synthetic CHECKPOINT_STEP_ID
            // and type: "step" (matches pendingErrorSourceToStepType("onCheckpoint")).
            await this.fireHook(state, "onStepError", {
              stepId: CHECKPOINT_STEP_ID, type: "step", ctx: state.ctx, error: e,
              durationMs: performance.now() - ckptStart,
            });
          }
        }
      }
    }

    // Tail — mutually exclusive branches.
    // Precedence: checkpointFailed > finally-wrap > original-step > suspension.
    if (pendingError && !state.suspension) {
      if (state.checkpointFailed) {
        // Checkpoint error reaches caller bare; finally errors get console.warn
        // because the rejection path can't carry warnings.
        const warningsArr = state.warnings ?? [];
        const checkpointError = pendingError.source === "onCheckpoint"
          ? pendingError.error
          : warningsArr.find(w => w.source === "onCheckpoint")?.error;
        const finallyErrors = warningsArr.filter(w => w.source === "finally").map(w => w.error);
        const all = pendingError.source === "finally"
          ? [...finallyErrors, pendingError.error]
          : finallyErrors;
        if (all.length > 0) {
          console.warn(
            `pipeai: ${all.length} .finally() error(s) suppressed by checkpoint-failure precedence:`,
            all,
          );
        }
        throw checkpointError ?? pendingError.error;
      }
      const isFinallyPath = pendingError.source === "finally"
        || (state.warnings?.some(w => w.source === "finally") ?? false);
      if (isFinallyPath) {
        // Source order: warnings were pushed in the order errors occurred (step
        // before finally, earlier finally before later finally), so this preserves
        // the chronological sequence the plan specifies. Single-error case included
        // — once any finally is in the picture, the contract is AggregateError.
        const all = [...(state.warnings ?? []).map(w => w.error), pendingError.error];
        throw new AggregateError(all, `Workflow failed with ${all.length} error(s) from .finally() bodies`);
      }
      throw pendingError.error;
    } else if (pendingError && state.suspension) {
      // Suspension wins; preserve the step error as a warning.
      demotePendingError(state, pendingError);
      // Also emit onStepError so observers can see the loss.
      try {
        await this.observability?.onStepError?.({
          stepId: pendingError.stepId,
          type: pendingErrorSourceToStepType(pendingError.source),
          ctx: state.ctx,
          error: pendingError.error,
          durationMs: 0,
        });
      } catch (obsError) {
        pushWarning(state, "onStepError", pendingError.stepId, obsError);
      }
      pendingError = null;
    }
  }

  // ── Internal: execute a nested workflow within a step/loop ─────
  // Defined on SealedWorkflow (not Workflow) because TypeScript's protected
  // access rules only allow calling workflow.execute() from the same class.
  //
  // Contract: clears any inner suspension before re-throwing as
  // NestedGateUnsupportedError. The outer execute() therefore never observes
  // a leaked `state.suspension` from non-gate nodes (defensive invariant).

  protected async executeNestedWorkflow(
    state: RuntimeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    workflow: SealedWorkflow<TContext, unknown, unknown, any>,
  ): Promise<void> {
    // RunOptions is run-scoped — child never inherits parent's runOptions.
    // state.warnings IS propagated (asymmetric on purpose: telemetry > config).
    const savedRunOptions = state.runOptions;
    state.runOptions = undefined;
    try {
      await workflow.execute(state);
    } finally {
      state.runOptions = savedRunOptions;
    }
    if (state.suspension) {
      const gateId = state.suspension.gateId;
      state.suspension = undefined;   // clear before throw (load-bearing invariant 1)
      throw new NestedGateUnsupportedError(gateId, workflow.id);
    }
  }

  // ── Internal: execute an agent within a step/branch ───────────
  // In stream mode, output extraction awaits the full stream before returning.
  // Streaming benefits the client (incremental output), not pipeline throughput —
  // each step still runs sequentially.

  protected async executeAgent<TAgentInput, TNextOutput>(
    state: RuntimeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: Agent<TContext, any, TNextOutput>,
    ctx: TContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: AgentStepHooks<TContext, any, TNextOutput>,
  ): Promise<void> {
    const input = state.output as TAgentInput;
    const hasStructuredOutput = agent.hasOutput;

    const abortSignal = state.abortSignal;
    const agentCallOpts = abortSignal ? { abortSignal } : undefined;

    if (state.mode === "stream" && state.writer) {
      const writer = state.writer;
      // Run inside writer context so tools accessed via getActiveWriter() pick it up.
      await runWithWriter(writer, async () => {
        const result = await (agent.stream as (ctx: TContext, input: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<StreamTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output, agentCallOpts);

        if (options?.handleStream) {
          await options.handleStream({ result, writer, ctx, input });
        } else {
          writer.merge(result.toUIMessageStream());
        }

        const hookParams = {
          mode: "stream",
          result,
          ctx: ctx as Readonly<TContext>,
          input,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as AgentResultParams<TContext, any, TNextOutput>;

        if (options?.onResult) {
          await options.onResult(hookParams);
        }

        if (options?.mapResult) {
          state.output = await options.mapResult(hookParams);
        } else {
          state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
        }
      });
    } else {
      const result = await (agent.generate as (ctx: TContext, input: unknown, opts?: { abortSignal?: AbortSignal }) => Promise<GenerateTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output, agentCallOpts);

      const hookParams = {
        mode: "generate",
        result,
        ctx: ctx as Readonly<TContext>,
        input,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as AgentResultParams<TContext, any, TNextOutput>;

      if (options?.onResult) {
        await options.onResult(hookParams);
      }

      if (options?.mapResult) {
        state.output = await options.mapResult(hookParams);
      } else {
        state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
      }
    }
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
    const gateIndex = this.findGateIndex(gateLike);
    const gateNode = this.steps[gateIndex] as Extract<StepNode, { type: "gate" }>;
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
      mode: "checkpoint",
      priorOutput: ckpt.output,
      snapshot: ckpt,
      observability: this.observability,
    });
  }

  /**
   * Append a `.finally()` body to a sealed workflow, returning another sealed
   * workflow. Allows multi-finally chains (`.finally().finally()`). A throwing
   * `.finally` body does NOT abort subsequent ones — they all run.
   */
  finally(
    id: string,
    fn: (params: { ctx: Readonly<TContext> }) => MaybePromise<void>,
  ): SealedWorkflow<TContext, TInput, TOutput, TGates> {
    const node: StepNode = {
      type: "finally",
      id,
      execute: async (state) => {
        await fn({ ctx: state.ctx as Readonly<TContext> });
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new SealedWorkflow<TContext, TInput, TOutput, TGates>([...this.steps, node] as any, this.id, this.observability);
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
  readonly mode: "gate" | "checkpoint";
  readonly schema?: SchemaWithParse<unknown>;
  readonly mergeFn?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;
  readonly priorOutput?: unknown;
  readonly snapshot?: WorkflowSnapshot;
  readonly observability?: WorkflowObservability;
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

  /** @internal */
  constructor(
    steps: ReadonlyArray<StepNode>,
    startIndex: number,
    config: ResumedWorkflowConfig,
  ) {
    super(steps, undefined, config.observability);
    this.startIndex = startIndex;
    this.schema = config.schema as SchemaWithParse<TResponse> | undefined;
    this.mergeFn = config.mergeFn;
    this.priorOutput = config.priorOutput;
  }

  private validateResponse(response: TResponse): TResponse {
    if (this.schema) {
      return this.schema.parse(response) as TResponse;
    }
    return response;
  }

  override async generate(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, opts?: RunOptions]
      : [response: TResponse, opts?: RunOptions]
  ): Promise<WorkflowResult<TOutput>> {
    const rawResponse = args[0] as TResponse;
    const opts = args[1] as RunOptions | undefined;
    // Run prep (schema.parse + mergeFn) inside the workflow's error pipeline
    // so a downstream `.catch()` can observe failures here. Without this,
    // a schema/merge throw would reject the promise raw, bypassing catch.
    let output: unknown = this.priorOutput;
    let initialError: PendingError | null = null;
    try {
      const response = this.validateResponse(rawResponse);
      output = this.mergeFn
        ? await this.mergeFn({ priorOutput: this.priorOutput, response })
        : response;
    } catch (error) {
      initialError = { error, stepId: "gate:resume", source: "step" };
    }
    const state: RuntimeState = {
      ctx,
      output,
      mode: "generate",
      runOptions: opts,
      abortSignal: opts?.abortSignal,
    };
    await this.execute(state, this.startIndex, opts, initialError);
    return this.buildResult(state);
  }

  override stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
      : [response: TResponse, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput> {
    const rawResponse = args[0] as TResponse;
    const options = args[1] as WorkflowStreamOptions<UI_MESSAGE> | undefined;
    const opts = args[2] as RunOptions | undefined;
    const abortSignal = opts?.abortSignal;

    let resolveOutput!: (value: WorkflowResult<TOutput>) => void;
    let rejectOutput!: (error: unknown) => void;
    const outputPromise = new Promise<WorkflowResult<TOutput>>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    outputPromise.catch(() => {});

    const mergeFn = this.mergeFn;
    const priorOutput = this.priorOutput;
    const startIndex = this.startIndex;

    const stream = createUIMessageStream<UI_MESSAGE>({
      execute: async ({ writer }) => {
        // Run prep (schema.parse + mergeFn) inside the error pipeline (same as
        // generate()). Without this, a schema parse throw escapes synchronously
        // from .stream(...) and bypasses any downstream .catch().
        let output: unknown = priorOutput;
        let initialError: PendingError | null = null;
        try {
          const response = this.validateResponse(rawResponse);
          output = mergeFn
            ? await mergeFn({ priorOutput, response })
            : response;
        } catch (error) {
          initialError = { error, stepId: "gate:resume", source: "step" };
        }
        const state: RuntimeState = {
          ctx,
          output,
          mode: "stream",
          writer,
          runOptions: opts,
          abortSignal,
        };

        try {
          await this.execute(state, startIndex, opts, initialError);
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
    steps: ReadonlyArray<StepNode>,
    startIndex: number,
    config: ResumedWorkflowConfig,
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
    this.validateRunOptions(opts);
    const state: RuntimeState = {
      ctx,
      output: this.priorOutput,
      mode: "generate",
      runOptions: opts,
    };
    await this.execute(state, this.startIndex, opts);
    return this.buildResult(state);
  }

  override stream<UI_MESSAGE extends UIMessage = UIMessage>(
    ctx: TContext,
    ...args: [input?: void, options?: WorkflowStreamOptions<UI_MESSAGE>, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput> {
    const options = args[1];
    const opts = args[2];
    this.validateRunOptions(opts);

    let resolveOutput!: (value: WorkflowResult<TOutput>) => void;
    let rejectOutput!: (error: unknown) => void;
    const outputPromise = new Promise<WorkflowResult<TOutput>>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    outputPromise.catch(() => {});

    const priorOutput = this.priorOutput;
    const startIndex = this.startIndex;

    const stream = createUIMessageStream<UI_MESSAGE>({
      execute: async ({ writer }) => {
        const state: RuntimeState = {
          ctx,
          output: priorOutput,
          mode: "stream",
          writer,
          runOptions: opts,
        };
        try {
          await this.execute(state, startIndex, opts);
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
}

// ── Workflow ────────────────────────────────────────────────────────

export class Workflow<
  TContext,
  TInput = void,
  TOutput = void,
  TGates extends Record<string, unknown> = {},
> extends SealedWorkflow<TContext, TInput, TOutput, TGates> {

  /**
   * Sentinel value for `foreach`'s `onError` handler. Returning `Workflow.SKIP`
   * from `onError` omits the failed item's index from the output array,
   * shortening it relative to the input array.
   */
  static readonly SKIP: unique symbol = Symbol("pipeai.foreach.skip");

  private constructor(steps: ReadonlyArray<StepNode> = [], id?: string, observability?: WorkflowObservability) {
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
  // Centralizes the `[...steps, node] as any` + new Workflow + observability/id
  // forwarding pattern used by every combinator method.
  private appendStep<TNext, TG extends Record<string, unknown> = TGates>(
    node: StepNode,
  ): Workflow<TContext, TInput, TNext, TG> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNext, TG>([...this.steps, node] as any, this.id, this.observability);
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

  step<TNextOutput>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
    options: NestedStepOptions<TContext, TOutput, TNextOutput> & SkipPassthrough<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TOutput | TNextOutput, TGates>;
  step<TNextOutput>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
    options?: NestedStepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

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
      const node: StepNode = {
        type: "step",
        id: options?.id ?? workflow.id ?? "nested-workflow",
        nestedWorkflow: workflow,   // Feeds the recursive stepShapeHash walk.
        category: "nested",          // Observability event type.
        execute: async (state) => {
          if (await this.shouldSkip(state, options)) return;
          await this.executeNestedWorkflow(state, workflow as SealedWorkflow<TContext, unknown, unknown, any>);
        },
      };
      return this.appendStep<TNextOutput>(node);
    }

    // Transform overload: step(id, fn, options?)
    if (typeof target === "string") {
      if (typeof optionsOrFn !== "function") {
        throw new Error(`Workflow step("${target}"): second argument must be a function`);
      }
      const fn = optionsOrFn as (params: { ctx: Readonly<TContext>; input: TOutput; writer?: UIMessageStreamWriter }) => MaybePromise<TNextOutput>;
      const options = inlineOptions;
      const node: StepNode = {
        type: "step",
        id: target,
        execute: async (state) => {
          if (await this.shouldSkip(state, options)) return;
          state.output = await fn({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
            // Present in stream mode (undefined in generate mode), letting the
            // inline step emit UIMessageChunk parts onto the workflow's stream.
            writer: state.writer,
          });
        },
      };
      return this.appendStep<TNextOutput>(node);
    }

    // Agent overload: step(agent, options?)
    const agent = target;
    const options = optionsOrFn as StepOptions<TContext, TOutput, TNextOutput> | undefined;
    const node: StepNode = {
      type: "step",
      id: options?.id ?? agent.id,
      execute: async (state) => {
        if (await this.shouldSkip(state, options)) return;
        const ctx = state.ctx as TContext;
        await this.executeAgent(state, agent, ctx, options);
      },
    };
    return this.appendStep<TNextOutput>(node);
  }

  /**
   * Conditional-skip check shared by all `step` forms. Evaluates `when`; when
   * it returns false the step is skipped — `otherwise` (if present) produces
   * the output, otherwise the input passes through unchanged — and the body is
   * never invoked. Returns true when the caller should skip the body.
   */
  private async shouldSkip(
    state: RuntimeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options: ConditionalStepOptions<TContext, TOutput, any> | undefined,
  ): Promise<boolean> {
    if (!options?.when) return false;
    const ctx = state.ctx as Readonly<TContext>;
    const input = state.output as TOutput;
    if (await options.when({ ctx, input })) return false;
    if (options.otherwise) {
      state.output = await options.otherwise({ ctx, input });
    }
    // No `otherwise` → passthrough: leave state.output unchanged.
    return true;
  }

  // ── gate: human-in-the-loop suspension point ────────────────

  gate<TResponse = TOutput, Id extends string = string>(
    id: Id & (Id extends keyof TGates ? never : Id),
    options?: {
      payload?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<unknown>;
      schema?: SchemaWithParse<TResponse>;
      condition?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
      merge?: (params: { priorOutput: TOutput; response: TResponse }) => MaybePromise<TResponse>;
    }
  ): Workflow<TContext, TInput, TResponse, TGates & Record<Id, TResponse>> {
    if (this.steps.some(s => s.type === "gate" && s.id === id)) {
      throw new Error(`Workflow: duplicate gate ID "${id}". Each gate must have a unique identifier.`);
    }
    const node: StepNode = {
      type: "gate",
      id,
      schema: options?.schema,
      condition: options?.condition
        ? async (state) => options.condition!({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          })
        : undefined,
      merge: options?.merge
        ? (params) => options.merge!(params as { priorOutput: TOutput; response: TResponse })
        : undefined,
      payload: async (state) => {
        if (options?.payload) {
          return options.payload({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          });
        }
        return state.output;
      },
    };
    return this.appendStep<TResponse, TGates & Record<Id, TResponse>>(node);
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
    if (Array.isArray(casesOrConfig)) {
      return this.branchPredicate(casesOrConfig, options?.id);
    }
    return this.branchSelect(casesOrConfig, options?.id);
  }

  private branchPredicate<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[],
    explicitId?: string,
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    const node: StepNode = {
      type: "step",
      id: explicitId ?? "branch:predicate",
      category: "branch",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;

        for (const branchCase of cases) {
          if (branchCase.when) {
            const match = await branchCase.when({ ctx, input });
            if (!match) continue;
          }

          // Matched (or no `when` = default)
          await this.executeAgent(state, branchCase.agent, ctx, branchCase);
          return;
        }

        // Render the input defensively — JSON.stringify throws on cyclic /
        // BigInt / function-valued inputs, which would mask the real branch
        // mismatch with a serialization error.
        let inputRepr: string;
        try {
          inputRepr = JSON.stringify(input);
          if (inputRepr === undefined) inputRepr = String(input);
        } catch {
          inputRepr = `[unserializable ${typeof input}]`;
        }
        throw new WorkflowBranchError("predicate", `No branch matched and no default branch (a case without \`when\`) was provided. Input: ${inputRepr}`);
      },
    };
    return this.appendStep<TNextOutput>(node);
  }

  private branchSelect<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>,
    explicitId?: string,
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    const node: StepNode = {
      type: "step",
      id: explicitId ?? "branch:select",
      category: "branch",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;
        const key = await config.select({ ctx, input });

        // Distinguish "key not declared at all" from "key present but value
        // is `undefined`" (e.g. `agents: { bug: cond ? agentA : undefined }`).
        // The latter is a user-side bug — fail loud rather than silently
        // falling back, since the fallback obscures the misconfiguration.
        //
        // Use Object.prototype.hasOwnProperty.call (not `in`) so untrusted
        // classifier output like "toString"/"constructor"/"__proto__" doesn't
        // resolve to a Object.prototype method and crash executeAgent with an
        // opaque "agent.generate is not a function".
        const keyDeclared = Object.prototype.hasOwnProperty.call(config.agents, key);
        if (keyDeclared && (config.agents as Record<string, unknown>)[key] === undefined) {
          throw new WorkflowBranchError(
            "select",
            `Agent for key "${key}" was declared but the value is undefined. ` +
            `This usually means a conditional spread set the value to undefined. ` +
            `Available keys: ${Object.keys(config.agents).join(", ")}`,
          );
        }
        let agent = keyDeclared ? config.agents[key] : undefined;
        if (!agent) {
          if (config.onUnknownKey) {
            config.onUnknownKey({
              key,
              availableKeys: Object.keys(config.agents) as TKeys[],
              ctx: ctx as Readonly<TContext>,
            });
          }
          if (config.fallback) {
            agent = config.fallback;
          } else {
            throw new WorkflowBranchError("select", `No agent found for key "${key}" and no fallback provided. Available keys: ${Object.keys(config.agents).join(", ")}`);
          }
        }

        await this.executeAgent(state, agent, ctx, config);
      },
    };
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
   * @param options.concurrency Max items in flight at any moment (default 1).
   *   Backed by a semaphore: as soon as one item completes, the next launches —
   *   no lockstep batching.
   * @param options.onError Per-iteration error handler. **Bypassed entirely on
   *   the suspension path** (when any item hits a nested gate) — see the
   *   foreach concurrency hazards in the README. Otherwise: return a
   *   `TNextOutput` value to substitute, return `Workflow.SKIP` to omit, throw
   *   to abort. Invoked sequentially in index order after all items settle.
   */
  foreach<TNextOutput>(
    target: Agent<TContext, ElementOf<TOutput>, TNextOutput> | SealedWorkflow<TContext, ElementOf<TOutput>, TNextOutput>,
    options?: {
      id?: string;
      concurrency?: number;
      onError?: (params: {
        error: unknown;
        item: ElementOf<TOutput>;
        index: number;
        ctx: Readonly<TContext>;
      }) => MaybePromise<TNextOutput | typeof Workflow.SKIP>;
    },
  ): Workflow<TContext, TInput, TNextOutput[], TGates> {
    const concurrency = options?.concurrency ?? 1;
    const onError = options?.onError;
    const isWorkflow = target instanceof SealedWorkflow;
    const defaultId = isWorkflow
      ? (target.id ?? "foreach")
      : `foreach:${(target as Agent<TContext, ElementOf<TOutput>, TNextOutput>).id}`;
    const id = options?.id ?? defaultId;

    const node: StepNode = {
      type: "step",
      id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nestedWorkflow: isWorkflow ? (target as SealedWorkflow<any, any, any, any>) : undefined,
      category: "foreach",
      execute: async (state) => {
        const items = state.output;
        if (!Array.isArray(items)) {
          throw new Error(`foreach "${id}": expected array input, got ${typeof items}`);
        }

        const ctx = state.ctx as TContext;
        const results: unknown[] = new Array(items.length);
        const skipped = new Set<number>();
        const itemStates: (RuntimeState | undefined)[] = new Array(items.length);

        const executeItem = async (item: unknown, index: number) => {
          // itemState explicitly omits runOptions — per-run config never crosses
          // the foreach boundary. abortSignal IS propagated though, since
          // cancellation must be transitive across the foreach barrier.
          const itemState: RuntimeState = {
            ctx: state.ctx,
            output: item,
            mode: "generate",
            abortSignal: state.abortSignal,
          };
          itemStates[index] = itemState;
          const itemStart = performance.now();
          await this.fireHook(state, "onItemStart", {
            stepId: id, type: "foreach", itemIndex: index, ctx: state.ctx, input: item,
          });
          try {
            if (isWorkflow) {
              await this.executeNestedWorkflow(itemState, target as SealedWorkflow<TContext, unknown, unknown, any>);
            } else {
              await this.executeAgent(itemState, target as Agent<TContext, unknown, TNextOutput>, ctx);
            }
            results[index] = itemState.output;
            await this.fireHook(state, "onItemFinish", {
              stepId: id, type: "foreach", itemIndex: index, ctx: state.ctx, output: itemState.output,
              durationMs: performance.now() - itemStart,
            });
          } catch (error) {
            await this.fireHook(state, "onItemError", {
              stepId: id, type: "foreach", itemIndex: index, ctx: state.ctx, error,
              durationMs: performance.now() - itemStart,
            });
            throw error;
          }
        };

        // Merge per-item warnings into the parent state, namespaced.
        // Runs on EVERY exit path (success, suspension, or onError throw).
        const mergeItemWarnings = () => {
          for (let idx = 0; idx < items.length; idx++) {
            const its = itemStates[idx];
            if (!its?.warnings) continue;
            for (const w of its.warnings) {
              pushWarning(state, w.source, `${id}[${idx}]:${w.stepId}`, w.error);
            }
          }
        };

        const handleRejection = async (error: unknown, item: unknown, index: number) => {
          if (!onError) throw error;
          const recovered = await onError({
            error,
            item: item as ElementOf<TOutput>,
            index,
            ctx: state.ctx as Readonly<TContext>,
          });
          if (recovered === Workflow.SKIP) {
            skipped.add(index);
          } else {
            results[index] = recovered;
          }
        };

        // Collect rejections, then partition + branch.
        type Failure = { index: number; error: unknown };
        const failures: Failure[] = [];

        // Cooperative cancellation: bail before launching each item so a
        // large foreach doesn't fire off all items just because the parent's
        // abortSignal triggered mid-iteration. In-flight items already running
        // can't be yanked back, but their executeAgent call forwarded the
        // signal so the SDK side will tear them down.
        const signal = state.abortSignal;

        if (concurrency <= 1) {
          for (let i = 0; i < items.length; i++) {
            if (signal?.aborted) {
              failures.push({ index: i, error: signal.reason ?? new Error("Workflow aborted") });
              continue;
            }
            try {
              await executeItem(items[i], i);
            } catch (error) {
              failures.push({ index: i, error });
            }
          }
        } else {
          // Worker pool: O(concurrency) async closures share a counter rather
          // than O(N) closures all queuing on a semaphore. The shared
          // `nextIndex++` is safe because JS is single-threaded — the
          // read+increment is synchronous and the following `await` yields
          // AFTER the index is captured.
          let nextIndex = 0;
          const worker = async () => {
            while (true) {
              const i = nextIndex++;
              if (i >= items.length) return;
              if (signal?.aborted) {
                failures.push({ index: i, error: signal.reason ?? new Error("Workflow aborted") });
                continue;
              }
              try {
                await executeItem(items[i], i);
              } catch (error) {
                failures.push({ index: i, error });
              }
            }
          };
          const workers = Array.from(
            { length: Math.min(concurrency, items.length) },
            () => worker(),
          );
          await Promise.all(workers);
        }

        failures.sort((a, b) => a.index - b.index);

        // Partition into gate vs non-gate rejections.
        const gateFailures: { index: number; error: NestedGateUnsupportedError }[] = [];
        const nonGateFailures: Failure[] = [];
        for (const f of failures) {
          if (f.error instanceof NestedGateUnsupportedError) {
            gateFailures.push({ index: f.index, error: f.error });
          } else {
            nonGateFailures.push(f);
          }
        }

        // Always merge per-item warnings before deciding which path to take.
        mergeItemWarnings();

        if (gateFailures.length > 0) {
          // Suspension path — onError is bypassed entirely. Non-gate rejections
          // become foreach-sibling warnings. Lowest-index marker wins.
          for (const nr of nonGateFailures) {
            pushWarning(state, "foreach-sibling", `${id}[${nr.index}]`, nr.error);
          }
          const lowest = gateFailures[0];
          const otherSuspensions = gateFailures.slice(1).map(g => ({
            index: g.index,
            gateId: g.error.gateId,
          }));
          const siblingErrors = nonGateFailures.map(nr => nr.error);
          throw new NestedGateUnsupportedError(
            lowest.error.gateId,
            lowest.error.workflowId,
            siblingErrors,
            otherSuspensions,
          );
        }

        // No suspension — run onError per existing semantics in index order.
        for (const { index, error } of nonGateFailures) {
          await handleRejection(error, items[index], index);
        }

        state.output = skipped.size === 0
          ? results
          : results.filter((_, i) => !skipped.has(i));
      },
    };
    return this.appendStep<TNextOutput[]>(node);
  }

  // ── parallel: fan-out combinator ────────────────────────────────
  //
  // Same input fed to each branch. Generate mode only — writer is NOT threaded
  // through (interleaving multiple agent streams into one writer is not
  // supported). For SealedWorkflow branches, a nested gate throws
  // NestedGateUnsupportedError (same machinery as foreach concurrent).
  //
  // Default concurrency: `min(branches.length, 5)` — most users want fan-out,
  // not lockstep batching. Warn-once when branch count exceeds the 5 cap so
  // users notice unexpected rate-limit pressure.

  /** Record-form overload. Returns `{ [K]: BranchOutput<T[K]> }`. */
  parallel<TBranches extends Record<string, ParallelTarget<TContext, TOutput>>>(
    branches: TBranches,
    options?: ParallelOptions<TContext>,
  ): Workflow<TContext, TInput, ParallelOutputRecord<TBranches>, TGates>;

  /** Tuple-form overload. Returns `[O1, O2, ...]`. Use `as const`. */
  parallel<TBranches extends ReadonlyArray<ParallelTarget<TContext, TOutput>>>(
    branches: TBranches,
    options?: ParallelOptions<TContext>,
  ): Workflow<TContext, TInput, ParallelOutputTuple<TBranches>, TGates>;

  // Implementation
  parallel(
    branches: Record<string, ParallelTarget<TContext, TOutput>> | ReadonlyArray<ParallelTarget<TContext, TOutput>>,
    options?: ParallelOptions<TContext>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Workflow<TContext, TInput, any, TGates> {
    const isTuple = Array.isArray(branches);
    const entries: Array<{ key: string | number; index: number; target: ParallelTarget<TContext, TOutput> }> = isTuple
      ? (branches as ReadonlyArray<ParallelTarget<TContext, TOutput>>).map((target, i) => ({ key: i, index: i, target }))
      : Object.entries(branches as Record<string, ParallelTarget<TContext, TOutput>>).map(([k, t], i) => ({ key: k, index: i, target: t }));
    const branchCount = entries.length;
    const requestedConcurrency = options?.concurrency;
    let effectiveConcurrency: number;
    if (requestedConcurrency === undefined) {
      effectiveConcurrency = Math.min(branchCount, 5);
    } else {
      effectiveConcurrency = requestedConcurrency;
    }
    // Warn-once when >5 branches without explicit concurrency override.
    if (requestedConcurrency === undefined && branchCount > 5) {
      warnOnce(
        "pipeai:parallel-cap",
        `pipeai: parallel() with ${branchCount} branches capped at concurrency 5 by default. Pass { concurrency: ${branchCount} } (or Infinity) to opt in, or set { concurrency: N } if you want fewer.`,
      );
    }
    const onError = options?.onError;
    const id = options?.id ?? (isTuple ? "parallel:tuple" : "parallel:record");

    const node: StepNode = {
      type: "step",
      id,
      category: "parallel",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output;
        const results: Record<string | number, unknown> = (isTuple ? new Array(branchCount) : {}) as Record<string | number, unknown>;
        const branchStates: (RuntimeState | undefined)[] = new Array(branchCount);

        const executeBranch = async ({ key, index, target }: { key: string | number; index: number; target: ParallelTarget<TContext, TOutput> }) => {
          // Per-branch itemState — same isolation as foreach (no runOptions).
          const branchState: RuntimeState = { ctx: state.ctx, output: input, mode: "generate" };
          branchStates[index] = branchState;
          const branchStart = performance.now();
          // itemIndex is the key for record form, numeric index for tuple form.
          const itemIndex: string | number = isTuple ? index : (key as string);
          await this.fireHook(state, "onItemStart", {
            stepId: id, type: "parallel", itemIndex, ctx: state.ctx, input,
          });
          try {
            if (target instanceof SealedWorkflow) {
              await this.executeNestedWorkflow(branchState, target as SealedWorkflow<TContext, unknown, unknown, any>);
            } else {
              await this.executeAgent(branchState, target as Agent<TContext, unknown, unknown>, ctx);
            }
            results[key] = branchState.output;
            await this.fireHook(state, "onItemFinish", {
              stepId: id, type: "parallel", itemIndex, ctx: state.ctx, output: branchState.output,
              durationMs: performance.now() - branchStart,
            });
          } catch (error) {
            await this.fireHook(state, "onItemError", {
              stepId: id, type: "parallel", itemIndex, ctx: state.ctx, error,
              durationMs: performance.now() - branchStart,
            });
            throw error;
          }
        };

        // Same partition + suspension contract as foreach concurrent.
        type Failure = { key: string | number; index: number; error: unknown };
        const failures: Failure[] = [];

        const eff = Number.isFinite(effectiveConcurrency) ? Math.max(1, effectiveConcurrency) : branchCount;
        if (eff <= 1) {
          for (const e of entries) {
            try {
              await executeBranch(e);
            } catch (error) {
              failures.push({ key: e.key, index: e.index, error });
            }
          }
        } else {
          // Worker pool (same shape as foreach): K closures share a counter
          // instead of N closures queuing on a semaphore.
          let nextIndex = 0;
          const worker = async () => {
            while (true) {
              const i = nextIndex++;
              if (i >= branchCount) return;
              const e = entries[i];
              try {
                await executeBranch(e);
              } catch (error) {
                failures.push({ key: e.key, index: e.index, error });
              }
            }
          };
          const workers = Array.from(
            { length: Math.min(eff, branchCount) },
            () => worker(),
          );
          await Promise.all(workers);
        }

        // Always merge per-branch warnings into the parent, namespaced.
        for (let idx = 0; idx < branchCount; idx++) {
          const bs = branchStates[idx];
          if (!bs?.warnings) continue;
          for (const w of bs.warnings) {
            pushWarning(state, w.source, `${id}[${entries[idx].key}]:${w.stepId}`, w.error);
          }
        }

        // Partition rejections into gate vs non-gate.
        const gateFailures: { key: string | number; index: number; error: NestedGateUnsupportedError }[] = [];
        const nonGateFailures: Failure[] = [];
        for (const f of failures) {
          if (f.error instanceof NestedGateUnsupportedError) gateFailures.push({ key: f.key, index: f.index, error: f.error });
          else nonGateFailures.push(f);
        }
        gateFailures.sort((a, b) => a.index - b.index);
        nonGateFailures.sort((a, b) => a.index - b.index);

        if (gateFailures.length > 0) {
          // Suspension path — onError bypassed; non-gate rejections become warnings.
          for (const nr of nonGateFailures) {
            pushWarning(state, "foreach-sibling", `${id}[${nr.key}]`, nr.error);
          }
          const lowest = gateFailures[0];
          const otherSuspensions = gateFailures.slice(1).map(g => ({ index: g.index, gateId: g.error.gateId }));
          const siblingErrors = nonGateFailures.map(nr => nr.error);
          throw new NestedGateUnsupportedError(
            lowest.error.gateId,
            lowest.error.workflowId,
            siblingErrors,
            otherSuspensions,
          );
        }

        // No suspension — handle non-gate failures via onError or rethrow.
        for (const { key, index, error } of nonGateFailures) {
          if (!onError) throw error;
          const recovered = await onError({
            error,
            key: isTuple ? undefined : (key as string),
            index: isTuple ? (index) : undefined,
            ctx: state.ctx as Readonly<TContext>,
          });
          if (recovered === Workflow.SKIP) {
            // Record form: leave the key as `undefined`. Tuple form: same — the
            // slot stays `undefined`. The output type accepts SKIP only on the
            // record form at compile time.
            results[key] = undefined;
          } else {
            results[key] = recovered;
          }
        }

        state.output = results;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.appendStep<any>(node);
  }

  // ── repeat: conditional loop ─────────────────────────────────

  repeat(
    target: Agent<TContext, TOutput, TOutput> | SealedWorkflow<TContext, TOutput, TOutput>,
    options: RepeatOptions<TContext, TOutput> & { id?: string },
  ): Workflow<TContext, TInput, TOutput, TGates> {
    const maxIterations = options.maxIterations ?? 10;
    const isWorkflow = target instanceof SealedWorkflow;
    const defaultId = isWorkflow
      ? (target.id ?? "repeat")
      : `repeat:${(target as Agent<TContext, TOutput, TOutput>).id}`;
    const id = options.id ?? defaultId;
    const predicate: LoopPredicate<TContext, TOutput> = options.until
      ?? (async (p) => !(await options.while!(p)));

    const node: StepNode = {
      type: "step",
      id,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      nestedWorkflow: isWorkflow ? (target as SealedWorkflow<any, any, any, any>) : undefined,
      category: "repeat",
      execute: async (state) => {
        const ctx = state.ctx as TContext;

        for (let i = 1; i <= maxIterations; i++) {
          // Cancellation checkpoint between iterations. The body's executeAgent
          // already forwards the signal so an in-flight call cancels too, but
          // the explicit check here covers SealedWorkflow bodies and transform-
          // only loops where the signal wouldn't otherwise propagate.
          if (state.abortSignal?.aborted) {
            throw state.abortSignal.reason ?? new Error("Workflow aborted");
          }

          if (isWorkflow) {
            await this.executeNestedWorkflow(state, target as SealedWorkflow<TContext, unknown, unknown, any>);
          } else {
            await this.executeAgent(state, target as Agent<TContext, TOutput, TOutput>, ctx);
          }

          const done = await predicate({
            output: state.output as TOutput,
            ctx: ctx as Readonly<TContext>,
            iterations: i,
          });
          if (done) return;
        }

        throw new WorkflowLoopError(maxIterations, maxIterations);
      },
    };
    return this.appendStep<TOutput>(node);
  }

  // ── catch ─────────────────────────────────────────────────────

  catch(
    id: string,
    fn: (params: { error: unknown; ctx: Readonly<TContext>; lastOutput: TOutput; stepId: string }) => MaybePromise<TOutput>
  ): Workflow<TContext, TInput, TOutput, TGates> {
    if (!this.steps.some(s => s.type === "step")) {
      throw new Error(`Workflow: catch("${id}") requires at least one preceding step.`);
    }
    const node: StepNode = {
      type: "catch",
      id,
      catchFn: fn as (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>,
    };
    return this.appendStep<TOutput>(node);
  }

  // `.finally()` is inherited from SealedWorkflow now (it lives there so
  // multi-finally chains are possible — `.finally().finally()`).
}
