import {
  createUIMessageStream,
  type UIMessageStreamWriter,
  type ToolSet,
} from "ai";
import { type Agent, type GenerateTextResult, type StreamTextResult, type OutputType } from "./agent";
import { computeStepShapeHash, deepFreeze, extractOutput, runWithWriter, Semaphore, warnOnce, type MaybePromise } from "./utils";

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
    super(`Gate "${gateId}" hit inside nested workflow "${workflowId ?? "(anonymous)"}". Nested gates are planned for F0.5.`);
    this.name = "NestedGateUnsupportedError";
    this.gateId = gateId;
    this.workflowId = workflowId;
    this.siblingErrors = siblingErrors;
    this.siblingSuspensions = siblingSuspensions;
  }
}

// ── Snapshot / Warnings / Run options ────────────────────────────────

/**
 * v2 gate snapshot (F1). The `kind` discriminant differentiates from
 * checkpoint snapshots. Older v1 form (F0 release 0.4.0) is accepted by
 * `loadState` for one release via the legacy interface below.
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
 * v2 checkpoint snapshot (F1). Carries a step-shape hash; resume verifies
 * the workflow definition hasn't drifted before continuing.
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
    | "onCheckpoint"        // F1 populates
    | "onStepStart"         // F3 populates
    | "onStepFinish"        // F3 populates
    | "onStepError"         // F0 populates on suspension-wins path; F3 widens
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

// Forward-compat: F0 only consumes `onStepError` for the suspension-wins path
// (when a step body throws but the gate already won the run). F3 widens.
export interface WorkflowObservability {
  onStepError?: (event: {
    stepId: string;
    type: WorkflowStepType;
    ctx: unknown;
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
   * as an error (catch is bypassed — see CHANGELOG).
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

export interface AgentStepHooks<TContext, TOutput, TNextOutput> {
  mapGenerateResult?: (params: { result: GenerateTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  mapStreamResult?: (params: { result: StreamTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  onGenerateResult?: (params: { result: GenerateTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  onStreamResult?: (params: { result: StreamTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  handleStream?: (params: {
    result: StreamTextResult<ToolSet, OutputType<TNextOutput>>;
    writer: UIMessageStreamWriter;
    ctx: Readonly<TContext>;
  }) => MaybePromise<void>;
}

// ── Step Options ────────────────────────────────────────────────────

export type StepOptions<TContext, TOutput, TNextOutput> = AgentStepHooks<TContext, TOutput, TNextOutput> & {
  /** Override the default step id (`agent.id`). Required when reusing the same
   *  agent across multiple steps in one workflow — the construction-time
   *  `(type, id)` walk rejects duplicates. */
  id?: string;
};

// ── Branch Types ────────────────────────────────────────────────────

export interface BranchCase<TContext, TOutput, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  when?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
  agent: Agent<TContext, TOutput, TNextOutput>;
}

export interface BranchSelect<TContext, TOutput, TKeys extends string, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  select: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TKeys>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: Record<TKeys, Agent<TContext, any, TNextOutput>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallback?: Agent<TContext, any, TNextOutput>;
}

// ── Result Types ────────────────────────────────────────────────────

export type WorkflowResult<TOutput> =
  | { readonly status: "complete"; readonly output: TOutput; readonly warnings: readonly WorkflowWarning[] }
  | { readonly status: "suspended"; readonly snapshot: GateSnapshot; readonly warnings: readonly WorkflowWarning[] };

export interface WorkflowStreamResult<TOutput> {
  stream: ReadableStream;
  output: Promise<WorkflowResult<TOutput>>;   // never rejects on suspension; rejects on real errors
}

export interface WorkflowStreamOptions {
  onError?: (error: unknown) => string;
  onFinish?: () => MaybePromise<void>;
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

// ── Schema type (structural — works with Zod, Valibot, ArkType, etc.) ──

interface SchemaWithParse<T = unknown> {
  parse(data: unknown): T;
}

// ── Step Node ───────────────────────────────────────────────────────

// The "step" variant gains an optional `nestedWorkflow` field in F1.
// It's used ONLY by the recursive `stepShapeHash` walk — runtime execution
// still goes through the closure inside `execute`. F3 splits this into
// discrete `nested`/`foreach`/`repeat` variants.
type StepNode =
  | {
      readonly type: "step";
      readonly id: string;
      readonly execute: (state: RuntimeState) => MaybePromise<void>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      readonly nestedWorkflow?: SealedWorkflow<any, any, any, any>;
    }
  | { readonly type: "catch"; readonly id: string; readonly catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown> }
  | { readonly type: "finally"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> }
  | { readonly type: "gate"; readonly id: string; readonly payload: (state: RuntimeState) => MaybePromise<unknown>; readonly schema?: SchemaWithParse; readonly condition?: (state: RuntimeState) => MaybePromise<boolean>; readonly merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown> };

/**
 * Sidecar dispatch map used by the recursive `stepShapeHash` walk.
 * The `Record<StepNode["type"], ...>` type forces an entry for every variant
 * — adding a new StepNode variant without updating this map is a TS compile
 * error. F1's current union is `step | catch | finally | gate`. F3 reshapes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const NESTED_WORKFLOWS_BY_TYPE: { [K in StepNode["type"]]: (n: Extract<StepNode, { type: K }>) => readonly SealedWorkflow<any, any, any, any>[] } = {
  step:    n => n.nestedWorkflow ? [n.nestedWorkflow] : [],
  gate:    () => [],
  catch:   () => [],
  finally: () => [],
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getNestedWorkflows(node: StepNode): readonly SealedWorkflow<any, any, any, any>[] {
  // The cast through `never` is safe because of how the Record's signature
  // narrows the function arg via the K key — at runtime it's the same node.
  return NESTED_WORKFLOWS_BY_TYPE[node.type](node as never);
}

interface RuntimeState {
  ctx: unknown;
  output: unknown;
  mode: "generate" | "stream";
  writer?: UIMessageStreamWriter;
  // F0 additions — only gates set `suspension`. F0.5 may widen to a frame stack.
  suspension?: GateSnapshot;
  warnings?: WorkflowWarning[];
  // F1 plumbing — populated in F1; F0 only allocates the field.
  checkpointFailed?: boolean;
  // Same RunOptions seen by execute(); reset to undefined inside nested workflows
  // and omitted from foreach itemState so per-run config doesn't leak into nested
  // execution.
  runOptions?: RunOptions;
  // F3 plumbing — set true on gate suspension so observability emit can fire
  // onStepFinish({suspended:true}) on the next pass. Unused in F0 but allocated.
  observabilityEmitGate?: boolean;
}

// Pending error tracked through a single execute() pass. The `source` discriminant
// drives the precedence tail (checkpointFailed > finally-wrap > step > suspension)
// and the F3 onStepError type mapping below.
type PendingError = {
  error: unknown;
  stepId: string;
  source: "step" | "finally" | "catch" | "onCheckpoint";
};

/**
 * Maps `PendingError.source` to the `WorkflowStepType` value that F3's
 * `onStepError` should report. F0 only fires onStepError for the
 * suspension-wins path, but the helper ships in F0 so F3 doesn't have to
 * revisit the dispatch site.
 *
 * `onCheckpoint` is mapped to `"step"` — consistent with F1's
 * `onStepError({ stepId: CHECKPOINT_STEP_ID, type: "step" })` contract.
 *
 * The exhaustive switch with no `default` and a narrowed return type
 * means adding a new `source` variant without updating this helper is a
 * TypeScript compile error.
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
 * F1 checkpoint emission — invokes `opts.onCheckpoint(snapshot, { signal })`
 * with optional timeout via AbortSignal. Throws to the caller on:
 *   - onCheckpoint itself throwing
 *   - timeout expiration (raises CheckpointTimeoutError)
 *
 * The caller (run loop) catches the throw and sets `state.checkpointFailed`,
 * which routes through the F0 precedence tail (`checkpointFailed > finally-wrap
 * > original-step > suspension`).
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
// Tracked module-level so the warning fires exactly once per process.
let warnedStreamOnErrorOnSuspend = false;

/**
 * @internal — test-only reset of the one-time stream-mode warn dedup. Lets
 * a test assert the `console.warn` fires under a known-clean state. Not part
 * of the supported API; do not rely on this from user code.
 */
export function __resetStreamOnErrorOnSuspendWarnForTests(): void {
  warnedStreamOnErrorOnSuspend = false;
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
  /**
   * Workflow observability hooks. Not `readonly` because F3 will wire it
   * through `Workflow.create({ observability })` and F0 tests need to inject
   * via subclass / `as any`. Until F3 ships, this is an internal seam — don't
   * mutate from user code.
   */
  protected observability?: WorkflowObservability;
  // Memoized — see ensureDuplicateCheck().
  private duplicateCheckPassed = false;
  // F1 memoization — computed lazily, terminal-instance-local.
  // Build pipelines once at module load and re-run via generate() to amortize.
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
   *     (F1's CHECKPOINT_STEP_ID lives in this namespace).
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

  // ── F1: shape-hash + RunOptions validation ─────────────────────

  /**
   * Count of executable nodes — i.e. NOT `catch` or `finally`. Drives
   * auto-cadence so adding cleanup steps doesn't surprise users with
   * extra checkpoint fires. Memoized per terminal instance.
   *
   * In F1, `branch`/`foreach`/`repeat` are still `type: "step"` internally
   * and therefore count as executable. F3 introduces them as discriminated
   * variants — the filter remains "not catch/finally", no change required.
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
    };

    await this.execute(state, 0, opts);

    return this.buildResult(state);
  }

  stream(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: WorkflowStreamOptions, opts?: RunOptions]
      : [input: TInput, options?: WorkflowStreamOptions, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput> {
    this.ensureDuplicateCheck();
    const input = args[0];
    const options = args[1] as WorkflowStreamOptions | undefined;
    const opts = args[2] as RunOptions | undefined;
    this.validateRunOptions(opts);

    let resolveOutput!: (value: WorkflowResult<TOutput>) => void;
    let rejectOutput!: (error: unknown) => void;
    const outputPromise = new Promise<WorkflowResult<TOutput>>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });

    // Prevent unhandled rejection warning if the consumer never awaits `output`.
    outputPromise.catch(() => {});

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const state: RuntimeState = {
          ctx,
          output: input,
          mode: "stream",
          writer,
          runOptions: opts,
        };

        try {
          await this.execute(state, 0, opts);
          const result = this.buildResult(state);
          if (result.status === "suspended" && options?.onError && !warnedStreamOnErrorOnSuspend) {
            warnedStreamOnErrorOnSuspend = true;
            console.warn(
              "pipeai: stream() with options.onError suspended at a gate — onError will NOT be invoked for suspension. Discriminate via the resolved output Promise."
            );
          }
          resolveOutput(result);
        } catch (error) {
          rejectOutput(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
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

  protected async execute(state: RuntimeState, startIndex: number = 0, opts?: RunOptions): Promise<void> {
    if (this.steps.length === 0) {
      throw new Error("Workflow has no steps. Add at least one step before calling generate() or stream().");
    }

    // Make sure runOptions is plumbed even if the caller didn't initialize state.
    if (opts !== undefined && state.runOptions === undefined) {
      state.runOptions = opts;
    }

    let pendingError: PendingError | null = null;

    for (let i = startIndex; i < this.steps.length; i++) {
      const node = this.steps[i];

      if (node.type === "finally") {
        try {
          await node.execute(state);
        } catch (e) {
          // Multi-error preservation: never silently overwrite a prior pendingError —
          // push it to warnings before promoting this finally error.
          if (pendingError) {
            (state.warnings ??= []).push({
              source: pendingError.source,
              stepId: pendingError.stepId,
              error: pendingError.error,
            });
          }
          pendingError = { error: e, stepId: node.id, source: "finally" };
        }
        continue;
      }

      if (node.type === "catch") {
        // .catch() bypassed on suspension AND on checkpoint failure (F1 — propagates to caller).
        if (state.suspension || !pendingError || state.checkpointFailed) continue;
        try {
          state.output = await node.catchFn({
            error: pendingError.error,
            ctx: state.ctx,
            lastOutput: state.output,
            stepId: pendingError.stepId,
          });
          pendingError = null;
        } catch (e) {
          if (pendingError) {
            (state.warnings ??= []).push({
              source: pendingError.source,
              stepId: pendingError.stepId,
              error: pendingError.error,
            });
          }
          pendingError = { error: e, stepId: node.id, source: "catch" };
        }
        continue;
      }

      // Skip remaining non-finally/non-catch nodes when suspended or in error state.
      if (state.suspension || pendingError) continue;

      if (node.type === "gate") {
        if (node.condition && !(await node.condition(state))) continue;
        const snapshot: GateSnapshot = {
          version: 2,
          kind: "gate",
          resumeFromIndex: i,
          output: state.output,
          gateId: node.id,
          gatePayload: await node.payload(state),
        };
        state.suspension = snapshot;
        state.observabilityEmitGate = true;   // F3 forward-compat
        if (resolveFreezeSnapshots(state)) deepFreeze(snapshot);
        continue;
      }

      // type === "step"
      try {
        await node.execute(state);
      } catch (e) {
        pendingError = { error: e, stepId: node.id, source: "step" };
      }

      // Defensive invariant — by this point node.type === "step" (gate/finally/catch
      // already continued above), and gate is the only node type that legitimately
      // sets state.suspension. executeNestedWorkflow/foreach clear inner suspension
      // before rethrowing, so a non-undefined value here means a coding bug
      // somewhere bypassed that invariant. The cast is necessary because TypeScript
      // narrowed `state.suspension` to undefined at the top-of-loop falsy check; the
      // body could have mutated it through the await above, but TS doesn't know.
      //
      // catch.catchFn cannot leak suspension because its signature exposes only
      // `{error, ctx, lastOutput, stepId}` — no state access. finally bodies
      // likewise receive only `{ctx}`. So the defensive net only needs to cover
      // the step-execute path, which is where this check lives.
      const leaked = (state as { suspension?: GateSnapshot }).suspension;
      if (leaked) {
        state.suspension = undefined;   // reset to avoid cascading
        throw new Error(`internal: suspension bubbled from non-gate step "${node.id}" (gate "${leaked.gateId}").`);
      }

      // F1: emit checkpoint after a successful step body. Skipped on pendingError
      // (the step threw — no clean state to snapshot) or on suspension (gate
      // already won). Both `checkpointEvery` and `checkpointWhen` honor the
      // executable-count auto-cadence floor of `max(1, ceil(count / 4))`.
      if (!pendingError && !state.suspension && opts?.onCheckpoint) {
        const length = this.cachedExecutableStepCount;
        const cadence = opts.checkpointEvery ?? Math.max(1, Math.ceil(length / 4));
        const shouldCheckpoint = opts.checkpointWhen
          ? opts.checkpointWhen({ stepIndex: i, stepId: node.id, ctx: state.ctx })
          : (i + 1) % cadence === 0;
        if (shouldCheckpoint) {
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
      (state.warnings ??= []).push({
        source: pendingError.source,
        stepId: pendingError.stepId,
        error: pendingError.error,
      });
      // F3 forward-compat: also emit onStepError so observers can see the loss.
      try {
        await this.observability?.onStepError?.({
          stepId: pendingError.stepId,
          type: pendingErrorSourceToStepType(pendingError.source),
          ctx: state.ctx,
          error: pendingError.error,
          durationMs: 0,
        });
      } catch (obsError) {
        state.warnings.push({
          source: "onStepError",
          stepId: pendingError.stepId,
          error: obsError,
        });
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

    if (state.mode === "stream" && state.writer) {
      const writer = state.writer;
      // Run inside writer context so tools (asTool, defineTool) can access the writer automatically
      await runWithWriter(writer, async () => {
        const result = await (agent.stream as (ctx: TContext, input: unknown) => Promise<StreamTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output);

        if (options?.handleStream) {
          await options.handleStream({ result, writer, ctx });
        } else {
          writer.merge(result.toUIMessageStream());
        }

        if (options?.onStreamResult) {
          await options.onStreamResult({ result, ctx, input });
        }

        if (options?.mapStreamResult) {
          state.output = await options.mapStreamResult({ result, ctx, input });
        } else {
          state.output = await extractOutput(result, hasStructuredOutput);
        }
      });
    } else {
      const result = await (agent.generate as (ctx: TContext, input: unknown) => Promise<GenerateTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output);

      if (options?.onGenerateResult) {
        await options.onGenerateResult({ result, ctx, input });
      }

      if (options?.mapGenerateResult) {
        state.output = await options.mapGenerateResult({ result, ctx, input });
      } else {
        state.output = await extractOutput(result, hasStructuredOutput);
      }
    }
  }

  // ── Gate: load persisted state for resumption ──────────────────

  loadState<K extends string & keyof TGates>(
    gateId: K,
    snapshot: WorkflowSnapshot,
  ): ResumedWorkflow<TContext, TGates[K], TOutput> {
    // F1 widens WorkflowSnapshot to GateSnapshot | CheckpointSnapshot | LegacyGateSnapshotV1.
    // Reject checkpoint snapshots here — use resumeFrom() for those.
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

  // ── F1: checkpoint resume ──────────────────────────────────────

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
   * workflow. Allows multi-finally chains (`.finally().finally()`). Throwing
   * finallys no longer abort subsequent ones — see CHANGELOG 0.4.0.
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
    // F0 accepted version: 1. F1 widens to 1 (legacy) | 2 (gate or checkpoint).
    // Gate-flavor v2 is discriminated by kind === "gate"; legacy v1 has no `kind`.
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
  /** F0 only `"gate"`; F1 adds `"checkpoint"`. */
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
    const response = this.validateResponse(args[0] as TResponse);
    const opts = args[1] as RunOptions | undefined;
    const output = this.mergeFn
      ? await this.mergeFn({ priorOutput: this.priorOutput, response })
      : response;
    const state: RuntimeState = { ctx, output, mode: "generate", runOptions: opts };
    await this.execute(state, this.startIndex, opts);
    return this.buildResult(state);
  }

  override stream(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, options?: WorkflowStreamOptions, opts?: RunOptions]
      : [response: TResponse, options?: WorkflowStreamOptions, opts?: RunOptions]
  ): WorkflowStreamResult<TOutput> {
    const response = this.validateResponse(args[0] as TResponse);
    const options = args[1] as WorkflowStreamOptions | undefined;
    const opts = args[2] as RunOptions | undefined;

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

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const output = mergeFn
          ? await mergeFn({ priorOutput, response })
          : response;
        const state: RuntimeState = {
          ctx,
          output,
          mode: "stream",
          writer,
          runOptions: opts,
        };

        try {
          await this.execute(state, startIndex, opts);
          const result = this.buildResult(state);
          if (result.status === "suspended" && options?.onError && !warnedStreamOnErrorOnSuspend) {
            warnedStreamOnErrorOnSuspend = true;
            console.warn(
              "pipeai: stream() with options.onError suspended at a gate — onError will NOT be invoked for suspension. Discriminate via the resolved output Promise."
            );
          }
          resolveOutput(result);
        } catch (error) {
          rejectOutput(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
    });

    return { stream, output: outputPromise };
  }
}

// ── Checkpoint-Resumed Workflow (F1) ─────────────────────────────────
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

  override stream(
    ctx: TContext,
    ...args: [input?: void, options?: WorkflowStreamOptions, opts?: RunOptions]
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

    const stream = createUIMessageStream({
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
          if (result.status === "suspended" && options?.onError && !warnedStreamOnErrorOnSuspend) {
            warnedStreamOnErrorOnSuspend = true;
            // eslint-disable-next-line no-console
            console.warn(
              "pipeai: stream() with options.onError suspended at a gate — onError will NOT be invoked for suspension. Discriminate via the resolved output Promise."
            );
          }
          resolveOutput(result);
        } catch (error) {
          rejectOutput(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
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

  private constructor(steps: ReadonlyArray<StepNode> = [], id?: string) {
    super(steps, id);
  }

  static create<TContext, TInput = void>(options?: { id?: string }): Workflow<TContext, TInput, TInput> {
    return new Workflow<TContext, TInput, TInput>([], options?.id);
  }

  static from<TContext, TInput, TOutput>(
    agent: Agent<TContext, TInput, TOutput>,
    options?: StepOptions<TContext, TInput, TOutput>
  ): Workflow<TContext, TInput, TOutput> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, any>([]).step(agent, options);
  }

  // ── step: agent overload ──────────────────────────────────────

  step<TNextOutput>(
    agent: Agent<TContext, TOutput, TNextOutput>,
    options?: StepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: nested workflow overload ─────────────────────────────

  step<TNextOutput>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: transform overload (replaces map + tap) ─────────────

  step<TNextOutput>(
    id: string,
    fn: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: implementation ──────────────────────────────────────

  step<TNextOutput>(
    target: Agent<TContext, TOutput, TNextOutput> | SealedWorkflow<TContext, TOutput, TNextOutput> | string,
    optionsOrFn?: StepOptions<TContext, TOutput, TNextOutput> | ((params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>)
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    // Nested workflow overload: step(workflow)
    if (target instanceof SealedWorkflow) {
      const workflow = target;
      const node: StepNode = {
        type: "step",
        id: workflow.id ?? "nested-workflow",
        nestedWorkflow: workflow,   // F1: feeds the recursive stepShapeHash walk
        execute: async (state) => {
          await this.executeNestedWorkflow(state, workflow as SealedWorkflow<TContext, unknown, unknown, any>);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node] as any, this.id);
    }

    // Transform overload: step(id, fn)
    if (typeof target === "string") {
      if (typeof optionsOrFn !== "function") {
        throw new Error(`Workflow step("${target}"): second argument must be a function`);
      }
      const fn = optionsOrFn as (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
      const node: StepNode = {
        type: "step",
        id: target,
        execute: async (state) => {
          state.output = await fn({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          });
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node] as any, this.id);
    }

    // Agent overload: step(agent, options?)
    const agent = target;
    const options = optionsOrFn as StepOptions<TContext, TOutput, TNextOutput> | undefined;
    const node: StepNode = {
      type: "step",
      id: options?.id ?? agent.id,
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        await this.executeAgent(state, agent, ctx, options);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node] as any, this.id);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TResponse, TGates & Record<Id, TResponse>>([...this.steps, node] as any, this.id);
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

        throw new WorkflowBranchError("predicate", `No branch matched and no default branch (a case without \`when\`) was provided. Input: ${JSON.stringify(input)}`);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node] as any, this.id);
  }

  private branchSelect<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>,
    explicitId?: string,
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    const node: StepNode = {
      type: "step",
      id: explicitId ?? "branch:select",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;
        const key = await config.select({ ctx, input });

        let agent = config.agents[key];
        if (!agent) {
          if (config.fallback) {
            agent = config.fallback;
          } else {
            throw new WorkflowBranchError("select", `No agent found for key "${key}" and no fallback provided. Available keys: ${Object.keys(config.agents).join(", ")}`);
          }
        }

        await this.executeAgent(state, agent, ctx, config);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node] as any, this.id);
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
          // the foreach boundary.
          const itemState: RuntimeState = { ctx: state.ctx, output: item, mode: "generate" };
          itemStates[index] = itemState;
          if (isWorkflow) {
            await this.executeNestedWorkflow(itemState, target as SealedWorkflow<TContext, unknown, unknown, any>);
          } else {
            await this.executeAgent(itemState, target as Agent<TContext, unknown, TNextOutput>, ctx);
          }
          results[index] = itemState.output;
        };

        // Merge per-item warnings into the parent state, namespaced.
        // Runs on EVERY exit path (success, suspension, or onError throw).
        const mergeItemWarnings = () => {
          for (let idx = 0; idx < items.length; idx++) {
            const its = itemStates[idx];
            if (!its?.warnings) continue;
            for (const w of its.warnings) {
              (state.warnings ??= []).push({
                source: w.source,
                stepId: `${id}[${idx}]:${w.stepId}`,
                error: w.error,
              });
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

        if (concurrency <= 1) {
          for (let i = 0; i < items.length; i++) {
            try {
              await executeItem(items[i], i);
            } catch (error) {
              failures.push({ index: i, error });
            }
          }
        } else {
          const sem = new Semaphore(concurrency);
          await Promise.all(items.map(async (item, i) => {
            await sem.acquire();
            try {
              await executeItem(item, i);
            } catch (error) {
              failures.push({ index: i, error });
            } finally {
              sem.release();
            }
          }));
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
            (state.warnings ??= []).push({
              source: "foreach-sibling",
              stepId: `${id}[${nr.index}]`,
              error: nr.error,
            });
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput[], TGates>([...this.steps, node] as any, this.id);
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
      execute: async (state) => {
        const ctx = state.ctx as TContext;

        for (let i = 1; i <= maxIterations; i++) {
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TOutput, TGates>([...this.steps, node] as any, this.id);
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
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TOutput, TGates>([...this.steps, node] as any, this.id);
  }

  // `.finally()` is inherited from SealedWorkflow now (it lives there so
  // multi-finally chains are possible — `.finally().finally()`).
}
