# Workflow simplification — design

**Date:** 2026-06-02
**Status:** Approved, pre-implementation
**Scope:** Internal refactor of `src/workflow.ts`. Public API and all documented
behavior stay stable. No feature changes.

## Problem

`src/workflow.ts` has grown to ~2733 lines in a single file. Two distinct pains:

1. **One giant file.** Error types, snapshot types, observability, a concurrency
   core, the `Workflow` builder, the `SealedWorkflow` executor, and the resume
   variants all live in one module.
2. **Tangled execution logic.** `SealedWorkflow.execute()` is a single ~310-line
   `for` loop that inlines, per `node.type`: participation rules, hook
   bracketing, error capture, abort promotion, checkpoint emission, and a dense
   terminal precedence reconciliation. It mixes three signalling mechanisms —
   thrown exceptions (caught into `pendingError`), a mutated `state.suspension`
   flag, and a `state.checkpointFailed` flag — then reconciles them in one tail.

## Constraints

- **Public API byte-stable.** Every existing `from "./workflow"` /
  `from "../workflow"` import must keep resolving to the same symbols.
- **Behavior stable.** Same precedence (`checkpointFailed > finally-wrap > step >
  suspension`), abort stickiness/re-promotion, warning ordering, and
  `AggregateError`-on-finally contract.
- **Internal-only changes permitted** where they buy real simplicity. The
  internal `StepNode` representation is *not* exported, so changing it is in
  scope.
- **The 265 existing tests** (`src/__tests__/workflow.test.ts`, 4582 lines) are
  the behavioral contract and must stay green throughout.

## Non-goals

- No public API additions, removals, or renames.
- No feature removal or merging (keep `freezeSnapshots`, checkpoint timeouts,
  legacy v1 snapshot acceptance, per-item `handleStream`, etc.).
- No semantic changes to gates, checkpoints, streaming, concurrency, or
  observability.
- No reformatting of unrelated code; no refactoring the `Agent` class.

## Key insight

Every step *body* (agent call, nested workflow, inline fn, conditional-skip via
`shouldSkip`) is already encapsulated in each `StepNode.execute` closure, built
by the builder with `this` captured. So `execute()` itself does *only*
orchestration. The orchestration is the tangle, and it is cleanly separable from
the bodies. We keep the bodies as closures and restructure the orchestration.

## Design

### 1. Module layout

`src/workflow.ts` becomes a directory `src/workflow/` with an `index.ts` barrel
that re-exports the current public surface verbatim. `./workflow` resolves to
`./workflow/index.ts`; all existing imports are unchanged. The old
`src/workflow.ts` file is deleted once the directory is in place.

| File | Contents |
|---|---|
| `errors.ts` | `WorkflowBranchError`, `WorkflowLoopError`, `NestedGateUnsupportedError`, `CheckpointTimeoutError`, and reserved id consts (`ABORT_STEP_ID`, `CHECKPOINT_STEP_ID`, `GATE_RESUME_STEP_ID`) |
| `snapshots.ts` | `GateSnapshot`, `CheckpointSnapshot`, `LegacyGateSnapshotV1`, `WorkflowSnapshot`, `migrateSnapshot` |
| `types.ts` | Public option/result types: `RunOptions`, `WorkflowResult`, `WorkflowStreamResult`, `WorkflowStreamOptions`, `AgentStepHooks`, `AgentResultParams`, step/conditional/nested/inline options, `BranchCase`, `BranchSelect`, `RepeatOptions`, all `Parallel*` types, `WorkflowObservability`, `WorkflowWarning`, `WorkflowStepType` |
| `runtime.ts` | `RuntimeState`, `PendingError`, `StateSeed`, `makeRuntimeState`, `pushWarning`, `demotePendingError`, `resolveFreezeSnapshots`, `pendingErrorSourceToStepType` |
| `checkpoint.ts` | `emitCheckpoint` |
| `concurrency.ts` | `mapConcurrent<R>` (generic worker pool), `reconcileUnitOutcomes`, `UnitOutcome`, `UnitFailure` (see §4) |
| `nodes.ts` | `WorkflowNode` interface, `BaseNode`, `StepNodeImpl`, `GateNodeImpl`, `CatchNodeImpl`, `FinallyNodeImpl`, `NodeOutcome`, `RunContext` |
| `executor.ts` | `ExecutionPass` — the fold loop + `finalize()` reducer |
| `sealed-workflow.ts` | `SealedWorkflow` class (caches, validation, `fireHook`, `executeAgent`, `executeNestedWorkflow`, `generate`/`stream`, `loadState`/`resumeFrom`/`finally`, delegates running to `ExecutionPass`) |
| `resumed.ts` | `ResumedWorkflow`, `CheckpointResumedWorkflow` |
| `builder.ts` | `Workflow` class (`create`/`from`/`step`/`gate`/`branch`/`foreach`/`parallel`/`repeat`/`catch`) |
| `index.ts` | Barrel re-exporting the current public surface |

Import DAG (no runtime cycles): `errors`/`snapshots`/`types` → `runtime` →
`checkpoint`/`concurrency`/`nodes`/`executor` → `sealed-workflow` → `resumed` +
`builder` → `index`. Type-only cross-references (e.g. `ParallelTarget` →
`SealedWorkflow`) use `import type`.

### 2. Polymorphic nodes (replaces the `StepNode` union + `node.type` switches)

```ts
type NodeOutcome =
  | { kind: "ran" }                                // completed or skipped; output already in state
  | { kind: "suspended"; snapshot: GateSnapshot }  // gate fired
  | { kind: "failed"; error: unknown; source: PendingError["source"] }
  | { kind: "recovered" };                         // catch cleared the pending error

interface WorkflowNode {
  readonly id: string;
  readonly obsType: WorkflowStepType;
  readonly policy: "normal" | "onError" | "always";  // participation rule
  readonly checkpointable: boolean;
  getNestedWorkflows(): readonly SealedWorkflow<any, any, any, any>[];
  run(rc: RunContext): Promise<NodeOutcome>;
}
```

- `policy` replaces the scattered skip conditionals. `BaseNode` exposes
  `participates(status): boolean` derived from `policy` (the executor calls
  `node.participates(this.status)`):
  - `"normal"` (step, gate): participate only when not suspended and no pending error.
  - `"onError"` (catch): participate only when there is a pending error, not
    suspended, and checkpoint has not failed.
  - `"always"` (finally): always participate.
- `obsType` replaces `getObservabilityType` / the `category` field.
- `getNestedWorkflows()` replaces the free `getNestedWorkflows` switch (feeds the
  shape-hash walk).
- `checkpointable` is `true` only for the step-category node (matches today's
  `type === "step"` checkpoint gating).

`BaseNode` provides a shared `bracket(rc, body)` that fires
`onStepStart`/`onStepFinish`/`onStepError` with `performance.now()` timing and
converts a thrown body into `{ kind: "failed" }`. This removes the four
near-identical bracketing blocks from the loop. The body conversion is the only
place a thrown step body becomes an orchestration outcome — exceptions are
*localized*, not eliminated.

Node bodies stay closures: the builder constructs
`new StepNodeImpl({ id, obsType, checkpointable, body })` where `body` is the
same closure it builds today (capturing `this.executeAgent` / `this.shouldSkip` /
`this.executeNestedWorkflow`). `GateNodeImpl` holds the
`payload`/`condition`/`merge`/`schema`; `CatchNodeImpl` holds `catchFn`;
`FinallyNodeImpl` holds the finally closure.

`RunContext` carries what a node's `run` needs from the pass: the `RuntimeState`,
a bound `fireHook`, and (for catch) the current `PendingError`. It does **not**
carry `executeAgent` etc. — those stay captured in the body closures (per the
"keep body as a closure" decision).

### 3. The executor (`ExecutionPass`)

A per-`execute()` object owning the loop-local mutable state that used to be
closure variables (`pendingError`, `suspension` view, `abortPromoted`,
`executableStepsSeen`, `ckptCadence`), plus the cross-cutting concerns.

```ts
for (let i = startIndex; i < nodes.length; i++) {
  this.injectAbortIfAborted();                  // may fold a synthetic "failed" (abort)
  const node = nodes[i];
  if (!node.participates(this.status)) continue; // policy-driven; no type switch
  this.fold(await node.run(this.rc), i);         // updates pendingError / suspension
  if (node.checkpointable) await this.maybeCheckpoint(node, i);
}
this.finalize();
```

Cross-cutting concerns the executor owns (not nodes, per the
"executor-owned concerns" decision):

- **Abort.** Checked at every iteration boundary before participation. On first
  observation: clear any in-progress suspension, demote any prior pending error
  to a warning, and fold a synthetic `failed` with `ABORT_STEP_ID`. Sticky:
  re-promoted on later iterations if a catch cleared it, and once more after the
  loop (terminal-catch case), exactly as today.
- **Checkpoint.** After a `ran` checkpointable node, advance
  `executableStepsSeen` and fire `emitCheckpoint` on cadence
  (`checkpointEvery` / default `max(1, ceil(checkpointableStepCount / 4))`) or
  `checkpointWhen`. On failure, set `checkpointFailed` and fold the
  `onCheckpoint`-sourced error.

`finalize()` is the precedence reducer, unchanged in behavior:
`checkpointFailed > finally-wrap > original-step > suspension`, including the
`AggregateError` construction on the finally path and the suspension-wins
demotion + `onStepError` emission.

`ExecutionPass` receives its capabilities via an `ExecutionHost` view of the
`SealedWorkflow` (`nodes`, `observability`, bound `fireHook`, `stepShapeHash`,
`checkpointableStepCount`) so it has no protected-access coupling and is
independently testable. `SealedWorkflow.execute()` shrinks to: empty-steps
guard, plumb `runOptions`, then `new ExecutionPass(host, state, opts).run(...)`.

### 4. Concurrency core (`foreach` / `parallel`)

Today `runUnitsConcurrently` is one ~85-line function with a 7-param signature
that conflates two unrelated jobs: generic concurrent dispatch and
workflow-specific reconciliation (warning merge + abort precedence + a
`instanceof NestedGateUnsupportedError` partition that decides
suspend-vs-`onError`). The per-unit work is *already* fully closure-captured by
`executeItem` / `executeBranch`, so the lever is splitting these two jobs apart.

Split into a generic primitive and a discriminant fold:

```ts
// Generic worker pool — no workflow knowledge, independently testable.
// Sequential when concurrency <= 1, else a pool of min(concurrency, count)
// workers sharing a counter. Honors the abort signal (pre-launch check).
async function mapConcurrent<R>(
  count: number,
  concurrency: number,
  signal: AbortSignal | undefined,
  runUnit: (index: number) => Promise<R>,
): Promise<R[]>;

// Each unit reports an outcome instead of throwing-or-returning. Carries its
// own inner warnings so reconcile needs no separate `unitStates` array.
type UnitOutcome =
  | { kind: "ran"; warnings?: WorkflowWarning[] }
  | { kind: "suspended"; gateId: string; workflowId?: string; warnings?: WorkflowWarning[] }
  | { kind: "failed"; error: unknown; warnings?: WorkflowWarning[] };

// Fold over the discriminant — replaces the instanceof partition. Merges
// warnings (namespaced `id[key]:stepId`), applies abort precedence, builds the
// NestedGateUnsupportedError on any suspension, else returns the failures for
// the caller's onError pass.
function reconcileUnitOutcomes(
  state: RuntimeState,
  id: string,
  keyAt: (index: number) => string | number,
  outcomes: UnitOutcome[],
): UnitFailure[];
```

`reconcileUnitOutcomes` is the child→parent reduction, kept shared because its
precedence (`abort > any-suspension > failures`, plus packing the
`NestedGateUnsupportedError` siblings — lowest-index gate wins, other gates →
`siblingSuspensions`, non-gate failures → `siblingErrors`, all index-ordered) is
subtle and must stay byte-identical across `foreach` and `parallel`. It is
deliberately *not* the executor's `finalize()` (different precedence) and *not*
part of `mapConcurrent` (which stays workflow-agnostic).

`executeItem` / `executeBranch` keep their existing `try/catch` (which fires
`onItemError`) but convert at the boundary: a `NestedGateUnsupportedError` thrown
by `executeNestedWorkflow` becomes `{ kind: "suspended" }`; any other throw
becomes `{ kind: "failed" }`; success is `{ kind: "ran" }`. `foreach`/`parallel`
then read as `mapConcurrent(...)` → `reconcileUnitOutcomes(...)` → `onError` loop.

**Behavior preserved exactly.** The pool already ran every unit to completion
regardless of gates (the old thrown marker was a *reporting* mechanism collected
by the pool, never sibling cancellation), so moving to returned outcomes changes
nothing observable. Abort still early-stops launching new units and wins over
suspension/`onError`. **`onItemError` still fires for a nested-gate suspension**
(it flows through `executeItem`'s catch today) — preserved. `mapConcurrent`
keeps a defensive catch so a truly unexpected throw still surfaces as a failure.

The only remaining use of exceptions here is `executeNestedWorkflow` throwing
`NestedGateUnsupportedError`, caught immediately at the unit boundary (and, in
the sequential top-level loop, converted to a `failed` outcome by
`BaseNode.bracket`). No `instanceof`-based partition across siblings survives.

### 5. What this does and does not remove

Removed (accidental complexity): the `node.type` dispatch switch, the
`getObservabilityType` indirection, the scattered participation conditionals, the
four duplicated hook-bracketing blocks, the mixing of exception/flag signalling
in one loop, and the `instanceof NestedGateUnsupportedError` partition in the
concurrency core.

Retained (essential complexity): multi-error precedence and the `AggregateError`
contract — relocated into `finalize()` as a readable reducer (~40 lines) but not
eliminated, because multiple errors genuinely can coexist. Likewise the
concurrent abort/suspension/`onError` precedence stays, as a `reconcileUnitOutcomes`
fold.

## Safety strategy

1. Establish green baseline: `npm run typecheck` and `npm test` both pass before
   any change.
2. Relocate pure modules first (`errors`, `snapshots`, `types`, `runtime`,
   `checkpoint`) behind the barrel, moving `runUnitsConcurrently` verbatim into
   `concurrency.ts` for now; run `typecheck` after each.
3. Introduce `nodes.ts` + `executor.ts` and rewire the builder to construct node
   classes, in an isolated commit; run the **full suite**.
4. Refactor the concurrency core (`mapConcurrent` + `reconcileUnitOutcomes` +
   unit outcomes in `foreach`/`parallel`) in its own isolated commit; run the
   **full suite**. Steps 3 and 4 are the only behaviorally-risky steps, each
   isolated so a bisect is trivial.
5. Extract `sealed-workflow.ts` / `resumed.ts` / `builder.ts`; delete the old
   `src/workflow.ts`.
6. Final `typecheck` + full suite + `npm run build` (tsup) to confirm the bundle
   still emits the same entry points.

Expected test diff: none beyond possibly import paths — and those resolve
through the barrel, so likely zero.

## Risks

- **Circular imports** between `sealed-workflow`, `builder`, `resumed`. Mitigated
  by the layered DAG and `import type` for type-only references.
- **Subtle ordering drift** in warning emission or hook firing during the
  executor rewrite. Mitigated by porting the exact sequence and the 265 tests.
- **Bundle surface change.** Mitigated by the verbatim barrel + a post-build
  check of `dist` entry points.
