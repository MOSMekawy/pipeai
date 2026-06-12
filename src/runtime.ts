// Runtime plumbing for the workflow engine: the per-run `RuntimeState` (and
// its construction), observability hook dispatch, warning bookkeeping,
// pending-error demotion, and the checkpoint sink. Coupled only to the public
// types in `./types` and the leaf `./errors` module — no value-level cycle
// through `./workflow` — so the `Step` subclasses in `./steps` import from
// here directly.

import type { UIMessageStreamWriter } from "ai";
import { deepFreeze, type MaybePromise } from "./utils";
import { ABORT_STEP_ID } from "./errors";
import type {
  CheckpointSnapshot,
  GateSnapshot,
  RunOptions,
  WorkflowObservability,
  WorkflowResult,
  WorkflowStepType,
  WorkflowWarning,
} from "./types";

// ── Per-run state ────────────────────────────────────────────────────

// Consumed by the run loop in ./workflow and every `Step` subclass. NOT
// re-exported from index.ts, so it stays out of the public package API.
export interface RuntimeState {
  ctx: unknown;
  output: unknown;
  mode: "generate" | "stream";
  writer?: UIMessageStreamWriter;
  // Only gates set `suspension`.
  suspension?: GateSnapshot;
  warnings?: WorkflowWarning[];
  checkpointFailed?: boolean;
  // Error channel for the fat-step model and the single source of truth for the
  // in-flight error: a `Step#execute` body parks its thrown error here instead
  // of letting it escape, and the run loop + `catch`/`finally` steps read and
  // clear it. (`catch`/`finally` bodies are the exception — their throws bubble
  // straight out of `execute` rather than parking here.)
  pendingError?: PendingError;
  // Same RunOptions seen by execute(); reset to undefined inside nested
  // workflows and omitted from foreach itemState so per-run config doesn't
  // leak into nested execution.
  runOptions?: RunOptions;
  // Cooperative cancellation. Held on state separately from runOptions
  // because — unlike freezeSnapshots — abortSignal SHOULD propagate into
  // nested workflows and foreach items.
  abortSignal?: AbortSignal;
  // Index of the node the run loop is currently executing. Set per iteration
  // so a `GateStep` can stamp `resumeFromIndex` into its suspension snapshot
  // without the loop reaching into the node.
  stepIndex?: number;
  // Set only when resuming a NESTED gate: the descent a `NestedWorkflowStep`
  // follows back down to the suspended child. Consumed (and cleared) one
  // nesting level at a time. See `ResumeDescent`.
  resumeDescent?: ResumeDescent;
}

/**
 * Drives resume re-entry for a gate that suspended inside nested workflows.
 * `remaining` is the list of child start-indices to descend through, one per
 * nesting level, ending with the innermost gate's `resumeFromIndex + 1`. When a
 * `NestedWorkflowStep` consumes the LAST entry it first seeds `state.output`
 * with `seedOutput` (the merged gate response) before running the innermost
 * child from that index.
 */
export type ResumeDescent = {
  readonly remaining: readonly number[];
  readonly seedOutput: unknown;
};

// Pending error tracked through a single execute() pass. The `source`
// discriminant drives the precedence tail
// (checkpointFailed > finally-wrap > step > suspension) and the onStepError
// type mapping in `pendingErrorSourceToStepType`.
export type PendingError = {
  error: unknown;
  stepId: string;
  source: "step" | "gate" | "finally" | "catch" | "onCheckpoint";
};

/**
 * The pending-error a cancellation promotes: the signal's reason under the
 * reserved {@link ABORT_STEP_ID}, recoverable-looking to `.catch()` but sticky
 * (the run loop re-promotes it).
 */
export function makeAbortError(signal: AbortSignal): PendingError {
  return {
    error: signal.reason ?? new Error("Workflow aborted"),
    stepId: ABORT_STEP_ID,
    source: "step",
  };
}

/**
 * Prepend a nested-workflow step index to a propagating gate suspension so
 * resume can descend back to the gate. Returns a fresh snapshot (re-frozen when
 * `freezeSnapshots` is on) since the original may be frozen.
 */
export function prependNestedPath(snapshot: GateSnapshot, index: number, state: RuntimeState): GateSnapshot {
  const next: GateSnapshot = { ...snapshot, nestedPath: [index, ...(snapshot.nestedPath ?? [])] };
  if (resolveFreezeSnapshots(state)) deepFreeze(next);
  return next;
}

export function resolveFreezeSnapshots(state: RuntimeState): boolean {
  return state.runOptions?.freezeSnapshots ? true : false;
}

/**
 * Map `PendingError.source` to the `WorkflowStepType` value that
 * `onStepError` should report. `onCheckpoint` is mapped to `"step"`,
 * consistent with the `{ stepId: CHECKPOINT_STEP_ID, type: "step" }` contract.
 * Exhaustive switch — adding a new `source` variant is a compile error.
 */
export function pendingErrorSourceToStepType(source: PendingError["source"]): WorkflowStepType {
  switch (source) {
    case "step": return "step";
    case "gate": return "gate";
    case "finally": return "finally";
    case "catch": return "catch";
    case "onCheckpoint": return "step";
  }
}

/**
 * Invoke `opts.onCheckpoint(snapshot, { signal })`, forwarding the run-level
 * abort signal so a cancelled run can tear down an in-flight checkpoint write
 * (provided the callback honors the signal — JS can't force-cancel a promise).
 * Throws on onCheckpoint failure; the run loop catches and sets
 * `state.pendingError` (source `"onCheckpoint"`), which routes through the
 * precedence tail (checkpointFailed > original-step > suspension).
 *
 * There is no framework-imposed timeout: every awaited callback (agent calls,
 * transforms, gates, lifecycle hooks) can equally hang, and the uniform way to
 * bound any of them is the run's `abortSignal` — race it against your own timer
 * if you need one, rather than have the engine special-case this one callback.
 */
export async function emitCheckpoint(
  state: RuntimeState,
  opts: RunOptions,
  resumeFromIndex: number,
  stepShapeHash: string,
): Promise<void> {
  if (!opts.onCheckpoint) return;
  // When freezing, the checkpoint path keeps executing — so deep-freezing
  // `state.output` directly would hand the next step a frozen input. Snapshot
  // an independent clone instead, leaving the live value mutable. (Snapshots
  // are meant to be serializable for Redis/S3/Postgres persistence, so a
  // structured clone is sound here.) Without freeze we alias as before.
  const willFreeze = resolveFreezeSnapshots(state);
  const snap: CheckpointSnapshot = {
    version: 2,
    kind: "checkpoint",
    resumeFromIndex,
    output: willFreeze ? structuredClone(state.output) : state.output,
    stepShapeHash,
  };
  if (willFreeze) deepFreeze(snap);

  await opts.onCheckpoint(snap, { signal: state.abortSignal });
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
 * Exported (module-internal; not re-exported from index) so migrated `Step`
 * subclasses can record warnings the same way.
 */
export function pushWarning(
  state: RuntimeState,
  source: WorkflowWarning["source"],
  stepId: string,
  error: unknown,
): void {
  (state.warnings ??= []).push({ source, stepId, error });
}

/**
 * Fire an observability hook safely against an explicit `observability` object.
 * Returns `undefined` synchronously when no hook is registered (allocation-free
 * no-hook path). On throw: non-`onStepError` hooks push a warning + console.error
 * and the error is returned; `onStepError` throws are returned for the caller to
 * attach as `cause`.
 *
 * Free function (not a method) so the `Step` subclasses — `foreach` /
 * `parallel`, which fire per-item events — can use their captured observability.
 * `SealedWorkflow#fireHook` delegates here with `this.observability`.
 */
export function fireHook<
  K extends keyof WorkflowObservability,
  E extends Parameters<NonNullable<WorkflowObservability[K]>>[0],
>(
  observability: WorkflowObservability | undefined,
  state: RuntimeState,
  name: K,
  event: E,
): MaybePromise<unknown> {
  const hook = observability?.[name];
  if (!hook) return undefined;
  return fireHookSlow(state, name, event, hook);
}

async function fireHookSlow<K extends keyof WorkflowObservability>(
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
      pushWarning(state, name, stepId, e);
      // eslint-disable-next-line no-console
      console.error(`pipeai: ${name} hook threw for stepId "${stepId}":`, e);
    }
    return e;
  }
}

/**
 * True when any per-item observability hook is registered on `observability`.
 * Lets `foreach` / `parallel` skip per-item timing + event allocation on
 * hook-less runs.
 */
export function hasItemHooks(observability: WorkflowObservability | undefined): boolean {
  return !!observability && !!(observability.onItemStart || observability.onItemFinish || observability.onItemError);
}

/**
 * Demote a pendingError into a warning. Used everywhere a new pendingError is
 * about to overwrite the prior one (finally/catch errors after a step error,
 * abort promoted over an in-flight error, suspension-wins tail).
 */
export function demotePendingError(state: RuntimeState, pe: PendingError): void {
  pushWarning(state, pe.source, pe.stepId, pe.error);
}

/**
 * Emit the one-shot stream-onError-on-suspend warning if applicable.
 */
export function maybeWarnStreamOnErrorOnSuspend(
  result: WorkflowResult<unknown>,
  options: { onError?: (error: unknown) => string } | undefined,
): void {
  if (result.status !== "suspended" || !options?.onError || warnedStreamOnErrorOnSuspend) return;
  warnedStreamOnErrorOnSuspend = true;
  console.warn(
    "pipeai: stream() with options.onError suspended at a gate — onError will NOT be invoked for suspension. Discriminate via the resolved output Promise."
  );
}

/**
 * Build the per-run `RuntimeState`. Centralizes the shape every entry point
 * (generate/stream + gate/checkpoint resume) used to hand-construct. `abortSignal`
 * is always sourced from `opts` so cancellation is honored uniformly — the
 * checkpoint-resume path previously omitted it.
 */
export function makeRuntimeState(
  ctx: unknown,
  output: unknown,
  mode: "generate" | "stream",
  opts: RunOptions | undefined,
  writer?: UIMessageStreamWriter,
): RuntimeState {
  return {
    ctx,
    output,
    mode,
    ...(writer ? { writer } : {}),
    runOptions: opts,
    abortSignal: opts?.abortSignal,
  };
}
