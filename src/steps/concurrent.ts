import type { RuntimeState } from "../workflow";
import { pushWarning } from "../workflow";

/** A unit (foreach item / parallel branch) that rejected. */
export type UnitFailure = { key: string | number; index: number; error: unknown };

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
  count: number,
  keyAt: (index: number) => string | number,
  unitStates: ReadonlyArray<RuntimeState | undefined>,
  signal: AbortSignal | undefined,
): UnitFailure[] {
  // Merge per-unit warnings into the parent (every exit path, once). Also assert
  // the no-gate-in-a-concurrent-unit invariant: gated targets are forbidden at
  // build time (the `NoGates` / `GatelessBranch` type brands), but that guard is
  // purely type-level. If a cast bypassed it and a unit suspended, its
  // suspension would otherwise be silently dropped (only `unitState.output` is
  // read) — so fail loud instead.
  for (let i = 0; i < count; i++) {
    const us = unitStates[i];
    if (!us) continue;
    if (us.suspension) {
      throw new Error(
        `internal: gate "${us.suspension.gateId}" suspended inside concurrent unit ${id}[${keyAt(i)}]. ` +
        `Gates are forbidden in foreach / parallel targets — a cast must have bypassed the build-time guard.`
      );
    }
    if (!us.warnings) continue;
    for (const w of us.warnings) {
      pushWarning(state, w.source, `${id}[${keyAt(i)}]:${w.stepId}`, w.error);
    }
  }

  // Cooperative cancellation wins over onError and suspension.
  if (signal?.aborted) {
    for (const f of failures) {
      pushWarning(state, "foreach-sibling", `${id}[${f.key}]`, f.error);
    }
    throw signal.reason ?? new Error("Workflow aborted");
  }

  // Hand the failures back for the caller's `onError` handling.
  return failures;
}
