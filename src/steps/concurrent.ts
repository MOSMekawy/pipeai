import type { UIMessageStreamWriter } from "ai";
import type { MaybePromise } from "../utils";
import type { Agent } from "../agent";
import { fireHook, hasItemHooks, pushWarning, type RuntimeState } from "../runtime";
import type { AgentStepHooks, WorkflowObservability } from "../types";
import type { SealedWorkflow } from "../workflow";
import { AgentStep } from "./agent-step";
import { Semaphore } from "./semaphore";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** A unit (foreach item / parallel branch) that rejected. */
export type UnitFailure = { key: string | number; index: number; error: unknown };

/**
 * One dispatchable unit of concurrent work: a foreach item or a parallel
 * branch. `key` is the unit's identity everywhere it surfaces — hook
 * `itemIndex`, warning namespace, `UnitFailure.key` (foreach: the item index;
 * parallel: the record key / tuple index). `isWorkflow` is computed by the
 * owning step (it already discriminates the target at construction) so this
 * module never needs a value-level `instanceof SealedWorkflow`.
 */
export type ConcurrentUnit = {
  readonly key: string | number;
  readonly input: unknown;
  readonly target: Agent<any, any, any> | SealedWorkflow<any, any, any, any>;
  readonly isWorkflow: boolean;
};

/**
 * Validate a `foreach` / `parallel` `concurrency` option: a positive integer
 * or `Infinity` (full fan-out, clamped by unit count). Rejects NaN / 0 /
 * negatives and fractional values. Returns the effective value — **default:
 * unbounded**.
 */
export function validateConcurrency(kind: "foreach" | "parallel", value: number | undefined): number {
  if (
    value !== undefined &&
    !((Number.isInteger(value) && value >= 1) || value === Infinity)
  ) {
    throw new Error(`${kind}: concurrency must be a positive integer or Infinity, got ${value}`);
  }
  return value ?? Infinity;
}

/**
 * The dispatch loop shared by `foreach` and `parallel`: run every unit through
 * a worker pool, fire per-item observability, then reconcile (warning-merge +
 * abort precedence via {@link reconcileUnits}).
 *
 * Per unit: a fresh `RuntimeState` is built — `runOptions` is omitted (per-run
 * config never crosses the concurrency boundary) while `abortSignal` IS
 * propagated (cancellation is transitive). Agent units inherit the parent's
 * stream mode + writer ONLY when a `handleStream` is supplied (else they run
 * generate — N agent streams are never auto-merged into one writer); workflow
 * units always inherit, streaming transitively via their own steps.
 *
 * Returns the non-gate failures, sorted by unit index, for the calling step's
 * `onError` semantics. Throws on abort — the calling step's `execute` captures
 * the throw onto `state.pendingError`.
 */
export async function dispatchUnits(params: {
  state: RuntimeState;
  stepId: string;
  kind: "foreach" | "parallel";
  units: ReadonlyArray<ConcurrentUnit>;
  concurrency: number;
  observability: WorkflowObservability | undefined;
  handleStream?: (params: {
    result: any;
    writer: UIMessageStreamWriter;
    ctx: any;
    input: any;
    itemIndex: any;
  }) => MaybePromise<void>;
  /** Write the unit's output into the caller's result shape (array / record). */
  onUnitSuccess: (index: number, output: unknown) => void;
}): Promise<UnitFailure[]> {
  const { state, stepId, kind, units, observability, handleStream, onUnitSuccess } = params;
  const unitStates: (RuntimeState | undefined)[] = new Array(units.length);
  const wantItemHooks = hasItemHooks(observability);

  const executeUnit = async (unit: ConcurrentUnit, index: number) => {
    const inheritStreaming = unit.isWorkflow || handleStream !== undefined;
    const unitState: RuntimeState = {
      ctx: state.ctx,
      output: unit.input,
      mode: inheritStreaming ? state.mode : "generate",
      writer: inheritStreaming ? state.writer : undefined,
      abortSignal: state.abortSignal,
    };
    unitStates[index] = unitState;
    const unitStart = wantItemHooks ? performance.now() : 0;
    if (wantItemHooks) {
      await fireHook(observability, state, "onItemStart", {
        stepId, type: kind, itemIndex: unit.key, ctx: state.ctx, input: unit.input,
      });
    }
    try {
      if (unit.isWorkflow) {
        await (unit.target as SealedWorkflow<any, any, any, any>).executeAsNested(unitState);
      } else {
        await AgentStep.runAgent(
          unitState,
          unit.target as Agent<any, any, any>,
          state.ctx,
          handleStream ? ({ handleStream } as AgentStepHooks<any, any, any>) : undefined,
          unit.key,
        );
      }
      onUnitSuccess(index, unitState.output);
      if (wantItemHooks) {
        await fireHook(observability, state, "onItemFinish", {
          stepId, type: kind, itemIndex: unit.key, ctx: state.ctx, output: unitState.output,
          durationMs: performance.now() - unitStart,
        });
      }
    } catch (error) {
      if (wantItemHooks) {
        await fireHook(observability, state, "onItemError", {
          stepId, type: kind, itemIndex: unit.key, ctx: state.ctx, error,
          durationMs: performance.now() - unitStart,
        });
      }
      throw error;
    }
  };

  // Bounded dispatch: a Semaphore gates the loop, acquiring a permit BEFORE
  // launching each unit so only K are ever in flight (`Infinity` → full
  // fan-out). Units self-evict from `inflight` on settle, so the set retains
  // O(K) promises, not O(N).
  const sem = new Semaphore(params.concurrency);
  const failures: UnitFailure[] = [];
  const inflight = new Set<Promise<void>>();
  for (let i = 0; i < units.length; i++) {
    if (state.abortSignal?.aborted) break;
    await sem.acquire();
    if (state.abortSignal?.aborted) { sem.release(); break; }
    const index = i;
    const unit = (async () => {
      try { await executeUnit(units[index], index); }
      catch (error) { failures.push({ key: units[index].key, index, error }); }
      finally { sem.release(); }
    })();
    inflight.add(unit);
    void unit.finally(() => inflight.delete(unit));
  }
  await Promise.all(inflight);
  failures.sort((a, b) => a.index - b.index);

  return reconcileUnits(state, stepId, failures, units, unitStates);
}

/**
 * Post-dispatch policy shared by `foreach` and `parallel`. Merges each unit's
 * warnings into the parent (namespaced `id[key]:stepId`), then applies
 * precedence:
 *
 *   - **abort wins** → surface pre-abort failures as `foreach-sibling` warnings
 *     and rethrow the abort reason;
 *   - otherwise → return the failures for the caller's `onError`.
 *
 * (Nested gates can't suspend a concurrent branch — gated targets are forbidden
 * at build time — so there is no nested-gate case here.) Throws on abort; the
 * caller (a step's `execute`) captures the throw onto `state.pendingError`.
 */
export function reconcileUnits(
  state: RuntimeState,
  id: string,
  failures: UnitFailure[],
  units: ReadonlyArray<ConcurrentUnit>,
  unitStates: ReadonlyArray<RuntimeState | undefined>,
): UnitFailure[] {
  // Merge per-unit warnings into the parent (every exit path, once). Also assert
  // the no-gate-in-a-concurrent-unit invariant: gated targets are forbidden at
  // build time (the `NoGates` / `GatelessBranch` type brands), but that guard is
  // purely type-level. If a cast bypassed it and a unit suspended, its
  // suspension would otherwise be silently dropped (only `unitState.output` is
  // read) — so fail loud instead.
  for (let i = 0; i < units.length; i++) {
    const us = unitStates[i];
    if (!us) continue;
    if (us.suspension) {
      throw new Error(
        `internal: gate "${us.suspension.gateId}" suspended inside concurrent unit ${id}[${units[i].key}]. ` +
        `Gates are forbidden in foreach / parallel targets — a cast must have bypassed the build-time guard.`
      );
    }
    if (!us.warnings) continue;
    for (const w of us.warnings) {
      pushWarning(state, w.source, `${id}[${units[i].key}]:${w.stepId}`, w.error);
    }
  }

  // Cooperative cancellation wins over onError and suspension.
  if (state.abortSignal?.aborted) {
    for (const f of failures) {
      pushWarning(state, "foreach-sibling", `${id}[${f.key}]`, f.error);
    }
    throw state.abortSignal.reason ?? new Error("Workflow aborted");
  }

  // Hand the failures back for the caller's `onError` handling.
  return failures;
}
