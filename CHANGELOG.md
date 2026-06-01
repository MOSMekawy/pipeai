# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Conditional steps: `when` / `otherwise` on every `step` form.** `step(agent, …)`, inline `step(id, fn, …)`, and nested `step(workflow, …)` now accept `when?: ({ ctx, input }) => boolean`. When it returns false the step is skipped and its body never runs. With `otherwise?: ({ ctx, input }) => TNextOutput` the skip produces that value (output stays `TNextOutput`); without it the input passes through and the output type widens to `TOutput | TNextOutput` (which collapses to one type for same-shape steps). Skipped steps still fire `onStepStart` / `onStepFinish`; `when` / `otherwise` errors route through `.catch()` like any step error. The nested `step(workflow)` form also gains an `id` override via its new options arg.
- **`WorkflowObservability` is now generic over `TContext`** (default `unknown`). `Workflow.create<Ctx>({ observability })` types `ctx` in every hook (`onStepStart` / `onStepFinish` / `onStepError` / `onItem*`) as `Ctx` instead of `unknown`, so callbacks can read context fields without casting. `input` / `output` stay `unknown` — they differ per step, so only the run-constant `ctx` is typed. Non-breaking: the bare `WorkflowObservability` form still resolves to the previous `unknown`-context shape.
- **Inline `.step(id, fn)` handlers now receive `writer?: UIMessageStreamWriter`** — the same writer the agent steps merge into. In a `.stream(...)` run an inline step can emit `UIMessageChunk` parts (status / data parts) to surface mid-pipeline progress before the terminal agent starts emitting tokens, without dropping out of `Workflow.stream(...)`. `writer` is `undefined` in generate mode (guard with `?.`). Non-breaking — existing `({ ctx, input })` destructures keep working. For ambient access inside step helpers, compose the AI SDK's `createUIMessageStream` directly (`getActiveWriter()` is no longer part of the public API — see Removed).
- **`handleStream` now receives `input: TOutput`** — the typed carry from the prior step. Closes the asymmetry with `mapResult` / `onResult`, which already receive `input` via `AgentResultParams`. Lets consumers read the upstream value inside `handleStream` without round-tripping through `ctx`. Non-breaking — existing destructures (`{ result, writer, ctx }`) keep working.
- **`WorkflowStreamOptions` now surfaces every option the AI SDK's `createUIMessageStream` accepts**, with honest types:
  - `onFinish` is typed as the AI SDK's `UIMessageStreamOnFinishCallback<UI_MESSAGE>` — receives the real payload (`messages`, `responseMessage`, `isAborted`, `isContinuation`, `finishReason?`). Previously the public type was `() => MaybePromise<void>`, hiding all of it and forcing consumers to cast through `unknown`.
  - `originalMessages?: UI_MESSAGE[]` — for chat resumption / continuation flows. Forwarded verbatim; AI SDK assumes persistence mode and assigns a response-message id when provided.
  - `generateId?: IdGenerator` — overrides the response message-id generator. Useful for deterministic IDs in tests or coordinating with a server-side ID space.
- **`WorkflowStreamOptions` is now generic** over `UI_MESSAGE extends UIMessage`, default `UIMessage`. `Workflow.stream` / `ResumedWorkflow.stream` / `CheckpointResumedWorkflow.stream` all accept the same method-local generic, so consumers can pass a narrower `UIMessage<METADATA, DATA_PARTS, TOOLS>` and have `onFinish`'s `responseMessage` / `messages` narrow accordingly. Existing call sites continue to compile against the `UIMessage` default.

### Removed

- **`getActiveWriter` is no longer exported from `pipeai`** (was added to the public surface in 0.8.0). It remains the internal mechanism that powers the writer hand-off, but is no longer a supported extension point. Reach the writer through the explicit paths instead: `defineTool` / `ToolProvider` inject `writer` into `execute(input, ctx, { writer })`, agent `onStepFinish` / `onFinish` / `onError` callbacks receive it, and inline `Workflow.step(id, fn)` handlers receive it. A hand-rolled `IToolProvider` (not built via `defineTool` / `ToolProvider`) that needs the writer should wrap its definition in `ToolProvider`/`defineTool`, which performs the injection.

### Fixed

- **`foreach` / `parallel` no longer route cancellation through `onError`.** When the run is aborted, a skipped/aborted branch was being fed to `onError` as an ordinary failure, letting recovery logic "recover" from a cancellation and pollute results. Both combinators now bypass `onError` on abort and rethrow the abort reason (mirroring `repeat`); failures collected before the abort are preserved as warnings.
- **`parallel` output types are now honest about `SKIP`.** Supplying `onError` (the only way a branch can `SKIP`) widens the output values to `BranchOutput | undefined` in both the record and tuple forms, instead of typing a possibly-`undefined` slot as a guaranteed value. Without `onError` the output stays precise.
- **`repeat` validates `maxIterations`.** A non-positive `maxIterations` (e.g. `0`) previously made the loop a silent no-op; it now throws `repeat: maxIterations must be a positive integer`.

### Notes

- AI SDK's `createUIMessageStream` also accepts an `onStepFinish` (per-model-step) callback. We intentionally do not expose it on `WorkflowStreamOptions` — pipeai already has two clearer step-finish callbacks at different granularities (`Agent.onStepFinish` for per-model-call, `WorkflowObservability.onStepFinish` for per-workflow-step). Adding a third one with the same name would be confusing. Reach for one of the two above instead.

## [0.8.0] - 2026-05-24

Combines the [fix/review-findings] correctness/ergonomics work with the F0+F1+F2+F3+F4 feature stack from master (suspension-as-return-value, step-level checkpointing, parallel combinator, workflow observability, graph-pattern docs).

### Breaking changes (in addition to all of 0.4.0)

- **`AgentStepHooks` collapsed from 5 mode-bifurcated callbacks to 3.** The four `mapGenerateResult` / `mapStreamResult` / `onGenerateResult` / `onStreamResult` hooks are replaced by two mode-discriminated ones: `mapResult` and `onResult`. Both receive `AgentResultParams<TContext, TOutput, TNextOutput>`, a discriminated union on `mode: "generate" | "stream"`. `handleStream` is unchanged (it's genuinely stream-only — no generate analog exists). Migration is mechanical:
  ```ts
  // Before:
  .step(agent, {
    mapGenerateResult: ({ result }) => result.text,
    mapStreamResult:   async ({ result }) => await result.text,
  })
  // After (one callback handles both — result.text is string in generate,
  // Promise<string> in stream; MaybePromise<TNextOutput> accepts either):
  .step(agent, {
    mapResult: ({ result }) => result.text,
  })
  // For mode-specific logic, discriminate:
  .step(agent, {
    mapResult: async (params) => {
      if (params.mode === "stream") return await params.result.text;
      return params.result.text;
    },
  })
  ```
- **`gate()` now has a third generic `TMerged`.** When you supply a `merge` callback, its return type becomes the workflow's downstream `TOutput`. Previously `merge` was forced to return `TResponse`, which contradicted the documented use case of combining pre-gate output with the human response into a new shape. Existing code without `merge` is unaffected (default `TMerged = TResponse`).
- **`BranchSelect.agents` is now typed `Record<TKeys, Agent<TContext, TOutput, TNextOutput>>`** (was `Agent<TContext, any, TNextOutput>`). Mismatched-input agents that previously compiled silently now fail at compile time.
- **`WorkflowSnapshot` is now generic in `TPayload`** (default `unknown`, so existing references compile unchanged). Narrow `gatePayload` by casting to `WorkflowSnapshot<MyPayload>`.
- **`extractOutput` (via Agent behavior) now throws** when an `output` schema is declared but the model returned no structured value. Previously it silently fell back to raw text.

### Added

- **`RunOptions.abortSignal?: AbortSignal`** — cooperative cancellation for `Workflow.generate` / `.stream` and `ResumedWorkflow.generate` / `.stream`. Checked at every step boundary inside `execute()`, forwarded to `Agent.generate` / `.stream` calls in `executeAgent`, propagated transitively into nested workflows and foreach items (unlike `freezeSnapshots`, which is run-scoped). `.finally()` bodies still run on the abort path; `.catch()` can observe the abort error via `state.abortSignal.reason`. The signal is sticky — a catch that swallows it gets re-aborted at the next step boundary.
- **`getActiveWriter()` and `TOOL_PROVIDER_BRAND` exported from `pipeai`** — custom `IToolProvider` implementations (not built via `defineTool` / `ToolProvider`) previously had no sanctioned way to reach the workflow's stream writer. They had to import from internal `./utils`. Both are now part of the public surface. Call `getActiveWriter()` from inside your returned `Tool.execute` callback (not from inside `createTool` — `createTool` runs during agent setup, before the writer is live).
- **`AgentConfig.validateOutput?: ZodType<TOutput>`** — optional Zod schema for runtime validation of the model's structured output. Distinct from `tool.outputSchema`.
- **`Agent.generate(ctx, input, options?)` and `Agent.stream(...)` accept `{ abortSignal }`** as an optional second arg.
- **`Agent.asTool` / `asToolProvider` forward `ToolExecutionOptions.abortSignal`** from the parent SDK loop to the sub-agent.
- **`AggregateError` from concurrent `foreach`** — when `concurrency > 1` and multiple items fail, all failures are surfaced via `AggregateError` instead of only the first. With `onError` set, handler throws are collected into a secondary `AggregateError`.
- **`BranchSelect.onUnknownKey?: (params: { key, availableKeys, ctx }) => void`** — diagnostic hook fired when `select` returns a key not in `agents`.
- **`Workflow.step(id, nestedWorkflow)` overload** — give nested workflows explicit IDs.
- **`ToolProvider` and `isToolProvider` exported** from `pipeai` (was: only `defineTool`).
- **Top-level `SKIP` re-export** — `import { SKIP } from "pipeai"` mirrors `Workflow.SKIP` for consumers who don't want to pull in the full `Workflow` class.
- **`defer<T>()` and `createToolCallingMockModel`** added to test helpers — deterministic concurrency barriers and tool-call streaming simulation.

### Changed

- **`foreach` concurrent path is a worker pool** (`O(concurrency)` memory). Previously the path used `items.map(async => sem.acquire/release)` which allocates O(N) async closures all queued on a `Semaphore`. The new path spawns `min(concurrency, items.length)` workers each pulling from a shared `nextIndex++` counter. For a foreach over 10k items with concurrency=4, this drops the closure-allocation cost from 10k to 4. All gate-suspension partition / failure-aggregation / per-item warning behavior is unchanged. The `Semaphore` class remains in `src/utils.ts` but is no longer used by the engine.
- **`finally` and `catch` handlers that themselves throw now preserve the original error as `.cause`** instead of silently shadowing it.
- **SDK boundary casts in `Agent`** replaced `as any` with `as unknown as Parameters<typeof generateText>[0]` (and `streamText`).
- Five timing-fragile tests refactored to use deferred-promise barriers instead of `setTimeout`-coordinated state machines.

### Fixed

- **`branchSelect`: prototype-chain keys (`"toString"`, `"constructor"`, `"__proto__"`, …) now route to `onUnknownKey`/`fallback`** instead of crashing `executeAgent` with the inherited `Object.prototype` method. Uses `Object.prototype.hasOwnProperty.call` instead of the `in` operator.
- **`ResumedWorkflow.stream`: gate-schema parse rejections on resume now flow through the workflow's `.catch()` pipeline** instead of throwing synchronously from `.stream(...)` and bypassing catch handlers.
- `Agent.stream()` wraps synchronous SDK throws so the user's `onError` is invoked.
- Gate `condition` and `payload` callbacks are now captured by the workflow's `pendingError` plumbing.
- `stopWhen` is no longer treated as a `Resolvable` — a bare `StopCondition` is itself a function, so the resolver heuristic in `resolveValue` previously misidentified it as a `(ctx, input) => StopCondition` resolver and called it with the wrong shape.

## [0.7.0] - 2026-05-08

**Additive. Workflow observability hooks (`Workflow.create({ observability })`) plus the F4 graph-pattern docs (no code).**

### Added — F3: workflow observability

- `Workflow.create({ id?, observability? })` — pass a `WorkflowObservability` object to receive lifecycle events. Threaded through every builder return so all subsequent `.step()`/`.gate()`/`.foreach()`/`.parallel()`/`.repeat()`/`.branch()`/`.catch()`/`.finally()` instances inherit it. `ResumedWorkflow` (gate resume) and `CheckpointResumedWorkflow` (checkpoint resume) inherit it through their resume constructors.
- `WorkflowObservability` interface — six optional hooks: `onStepStart`, `onStepFinish`, `onStepError`, `onItemStart`, `onItemFinish`, `onItemError`. All async-friendly (`MaybePromise<void>`).
- `WorkflowStepType` exported as the discriminant type on hook events: `"step" | "nested" | "gate" | "catch" | "finally" | "branch" | "foreach" | "repeat" | "parallel"`.

### Firing rules

| Node | `onStepStart` | `onStepFinish` (`suspended`) | `onStepError` |
|---|---|---|---|
| step / nested / branch / foreach / parallel / repeat | always | when body returns (`false`) | on body throw |
| gate (suspends) | always | `suspended: true` | never |
| gate (cond false → skip) | always | `suspended: false` | never |
| catch | only when `pendingError` set | when `catchFn` returns | when `catchFn` throws |
| finally | always (runs even after suspension) | always (`suspended: false`) | when body throws |

Skip-checked nodes (`state.suspension || pendingError` set on entry) emit nothing — `.finally()` is the exception.

`foreach` and `parallel` ALSO emit per-item events (`onItemStart` / `onItemFinish` / `onItemError`). `repeat` does NOT — its iteration count is data-dependent and per-item would mislead. The `itemIndex` is a number for `foreach` and `parallel` tuple form, a string for `parallel` record form.

### Error semantics

- Errors thrown inside `onStepStart`, `onStepFinish`, `onItemStart`, `onItemFinish`, `onItemError` → captured into `result.warnings` with the matching `source` tag + mirror to `console.error`.
- Errors thrown inside `onStepError` on the normal path → the ORIGINAL step error reaches the caller, with `error.cause = obsError` (preserves `instanceof` on the original).
- `onCheckpoint` failures (F1) fire `onStepError({ stepId: CHECKPOINT_STEP_ID, type: "step", ... })`.

### Concurrency

For concurrent runs of the same workflow against the same `ctx`, the OTel example in the README uses a per-`runId` key. Don't key observability state on `ctx` alone — concurrent runs share it.

### Added — F4: graph patterns (docs only)

The README's new "Graph patterns" section documents how to express:
- **Cycles** → `.repeat(subWorkflow, { until })`.
- **Multi-path branching with rejoin** → `.branch(...).step(...)`.
- **Fan-out / fan-in** → `.parallel({...}).step(...)`.

Self-recursion via `let recur; .repeat(recur, ...)` is NOT documented — `recur` is `undefined` at evaluation. A future F4.5 may add a `repeat(thunk)` overload.

### Verification

- 221 tests pass (`npm test`). 19 new F3 tests + 3 F4 smoke tests covering: per-step events fire with `durationMs >= 0`, onStepError attaches `cause`, onStepStart/Finish throws → warnings, gate suspends → `suspended: true`, gate cond-false → `suspended: false`, foreach/parallel emit per-item events, repeat does NOT emit per-item events, `step(workflow)` reports `type: "nested"`, `ResumedWorkflow` and `CheckpointResumedWorkflow` inherit observability, onCheckpoint failure routes to onStepError, skip-checked nodes emit nothing (except finally), per-runId concurrent OTel pattern doesn't interleave.

## [0.6.0] - 2026-05-08

**Additive. New `.parallel()` fan-out combinator. Contrast with `foreach`: parallel defaults to `min(N, 5)` concurrency (most users want fan-out), foreach defaults to `1` (most users want lockstep). Read on for the rate-limit hazard.**

### Added

- `Workflow.parallel(branches, options?)` — fan-out combinator with two type-overload forms:
  - **Record form:** `parallel({ a: agentA, b: agentB })` → `{ a: O_a, b: O_b }`
  - **Tuple form:** `parallel([agentA, agentB] as const)` → `[O_a, O_b]`
  Each branch receives the same input (`state.output`) and runs concurrently up to `concurrency`. Generate mode only — writer is NOT threaded through (interleaving multiple agent streams into one writer is out of scope).
- `ParallelOptions.concurrency` — default `min(branches.length, 5)`. Pass `Infinity` (or the branch count) for full fan-out on >5-branch calls. A one-time `console.warn` fires when the 5 cap kicks in to surface rate-limit hazards.
- `ParallelOptions.onError` — per-branch error handler. Receives `{ error, key?, index?, ctx }`. Return a value to substitute, return `Workflow.SKIP` to leave the slot undefined (record form), or rethrow to abort the parallel. Bypassed entirely on the suspension path.
- `ParallelOptions.id` — override the default step id (`parallel:record` or `parallel:tuple`).

### Exported types

- `ParallelTarget<TContext, TInput>` — branch target type (`Agent` or `SealedWorkflow`).
- `ParallelOutputRecord<T>` / `ParallelOutputTuple<T>` — output-shape helpers.
- `ParallelOptions<TContext>`.

### Suspension under parallel (deferred contract)

A gate inside a parallel branch reuses F0's `NestedGateUnsupportedError` mechanism — same as `foreach` concurrent: lowest-index marker wins, others in `siblingSuspensions`, non-gate rejections in `state.warnings` with `source: "foreach-sibling"` (we reuse the foreach source tag for now; F0.6 may add `parallel-sibling`). The detailed semantics for multi-branch suspension land in F0.6 alongside `cancelOnFirstSuspend`.

### Rate-limit hazard

`parallel`'s default `concurrency: min(N, 5)` assumes ≥5 RPS of headroom on your model provider. Symptoms of overflow: 429s and stair-stepped latency. If you're rate-limited, drop to `concurrency: 1` or split branches into stages.

### Concurrent ctx-mutation hazard

Branches share the `ctx` object by reference. Concurrent mutation of `ctx` from branches is a race; treat `ctx` as immutable inside parallel branches.

### Verification

- 202 tests pass (`npm test`). 14 new F2 tests covering: record/tuple output shapes, default `min(N,5)` concurrency, warn-once at the 5 cap, `concurrency: 1` serializing, `concurrency: Infinity`, onError substitution, `Workflow.SKIP` → undefined (record form), no-onError + branch throw, onError rethrow, gate-inside-branch → `NestedGateUnsupportedError`, multi-branch suspension lowest-index winner + `siblingSuspensions`, per-branch warning merge with namespaced stepId.

## [0.5.0] - 2026-05-08

**Additive at the public-API level. Snapshot version field widens (`1 → 1|2`) and gate snapshots gain a `kind` discriminant — runtime narrowing code that ignores `kind` is silently fragile. See the README's "Step-level checkpointing" section.**

### Added

- `RunOptions.onCheckpoint(snapshot, { signal })` — step-level checkpoint sink. Fires after each successful step body when cadence or predicate matches. Receives a v2 `CheckpointSnapshot` and an `AbortSignal` that aborts on `checkpointTimeout` expiration. Throwing here propagates as the run's terminal error (`.catch()` is bypassed via the F0 precedence tail).
- `RunOptions.checkpointEvery` — fire `onCheckpoint` every N executable steps. Mutually exclusive with `checkpointWhen`. Default: `max(1, ceil(executableCount / 4))` — 4 checkpoints across the run.
- `RunOptions.checkpointWhen({ stepIndex, stepId, ctx }) => boolean` — predicate variant.
- `RunOptions.checkpointTimeout` — ms before the AbortSignal fires. On timeout, a `CheckpointTimeoutError` is raised on the run.
- `freezeSnapshots: "iAcceptThePerformanceCost"` — escape hatch for the catastrophic-combo guard.
- `Workflow.resumeFrom(snapshot, { skipShapeCheck? })` — resume from a checkpoint snapshot. Validates `stepShapeHash` unless explicitly skipped.
- `CheckpointResumedWorkflow` — class returned by `resumeFrom`. Its `generate(ctx, opts?)` takes no response argument (state is seeded from the snapshot).
- `GateSnapshot` (v2 with `kind: "gate"`) and `CheckpointSnapshot` (v2 with `kind: "checkpoint"`) — discriminated snapshot variants.
- `LegacyGateSnapshotV1` — the F0/0.4.0 gate-only form. Accepted by `loadState` via a shim for one release. Migrate via `migrateSnapshot()` before v0.8.0+.
- `migrateSnapshot(legacy: LegacyGateSnapshotV1): GateSnapshot` — long-lived storage helper.
- `CheckpointTimeoutError` — thrown when `onCheckpoint` exceeds `checkpointTimeout`.
- `CHECKPOINT_STEP_ID = "::pipeai::onCheckpoint"` — synthetic step id reported when `onCheckpoint` throws.
- Recursive `stepShapeHash` (SHA-256) — encodes index/type/id + nested workflow shapes. Used by `resumeFrom` to detect drift. Cycle-safe via WeakSet. Memoized per terminal instance.
- `validateRunOptions` — pre-run validation: rejects bad `checkpointEvery`/`checkpointTimeout`, the `freezeSnapshots+checkpointEvery:1` catastrophic combo on 8+ step workflows, and warns once on `freezeSnapshots+cadence<=2`.

### Changed

- **Gate snapshots are now emitted as v2.** Newly suspended workflows produce `{ version: 2, kind: "gate", ... }`. Legacy v1 snapshots are still accepted by `loadState` for one release via the shim — migrate long-lived storage via `migrateSnapshot()` before v0.8.0+.
- `WorkflowSnapshot` is now a discriminated union: `GateSnapshot | CheckpointSnapshot | LegacyGateSnapshotV1`. Runtime narrowing code that ignores `kind` will need to add the discriminant.
- `findGateIndex` accepts both v1 and v2 gate snapshots.
- `loadState` rejects checkpoint snapshots with a clear error pointing at `resumeFrom`. `resumeFrom` likewise rejects gate snapshots.
- `Workflow.create({ ..., observability })` is **not** added yet — F3 ships that. The internal field is in place; F1 doesn't widen the public constructor.

### Rolling-deploy hazard

A 0.4.0 process receiving a 0.5.0-persisted v2 gate snapshot rejects via the strict `version === 1` check. Either:
- Drain in-flight 0.4.0 snapshots before cutover, OR
- Ship a 0.4.x patch that accepts both v1 and v2 ahead of cutover, OR
- Version-tag storage keys.

### Verification

- 188 tests pass (`npm test`). 31 new F1 tests covering: snapshot union + migration, checkpoint cadence (auto, every, predicate), timeout via AbortSignal, `resumeFrom` (success, gate-reject, shape-mismatch, skipShapeCheck, missing hash, bounds), `stepShapeHash` determinism, catastrophic-combo guard + escape hatch, `CHECKPOINT_STEP_ID` reservation.

## [0.4.0] - 2026-05-08

**Breaking — eight changes. See the README's "Migration from 0.3.x" section for the migration recipe.**

### Changed

1. **`.finally()` runs after a gate suspends.** Code that assumed `.finally()` ran only on completion must now check `result.status === "complete"`.
2. **Nested-workflow `.finally()` bodies run before `NestedGateUnsupportedError` fires.** Inner finallys see `state.suspension` truthy while running — don't branch on it. Side-effecting inner finallys execute on a path the user perceives as a thrown error.
3. **A throwing `.finally()` no longer aborts subsequent `.finally()` bodies.** All finallys run; their errors accumulate.
4. **`WorkflowSuspended` is deleted.** Migrate `try / catch (e instanceof WorkflowSuspended)` → `if (result.status === "suspended")`.
5. **`WorkflowResult<T>` is now a discriminated union.** `const { output } = await pipeline.generate(...)` is a strict-mode compile error. Use `if (result.status !== "complete") throw …; const { output } = result`.
6. **`stream()` on suspension closes cleanly.** The `output` Promise **resolves** with `{ status: "suspended", snapshot, warnings }` — it does **not** reject. `WorkflowStreamOptions.onError` is not invoked for suspension. Real errors still flow through `onError` and still reject `output`. A one-time `console.warn` fires per process when a gate fires in stream mode with `onError` set.
7. **Any** `.finally()` body that throws on the completion path produces `AggregateError` — including the single-error case. Stable contract once any finally is added.
8. **Duplicate `(type, id)` pairs in the same workflow throw at builder finalization.** `foreach(agentX).foreach(agentX)`, back-to-back default-id `branch(...)`, and `step(agent).step(agent)` (with the same agent reused) must pass an explicit `{ id }` option.

### Added

- `NestedGateUnsupportedError` replaces the previously thrown plain `Error` for gates inside `step(workflow)` / `foreach` / `repeat`. Carries `gateId`, `workflowId`, `siblingErrors` (non-gate rejections from concurrent foreach), and `siblingSuspensions` (other suspending items in concurrent foreach).
- `WorkflowResult<T>` discriminated union — `{ status: "complete", output, warnings } | { status: "suspended", snapshot, warnings }`.
- `WorkflowWarning` — non-fatal errors surfaced via `result.warnings` (sources: `step`, `finally`, `catch`, `onCheckpoint`, `onStepStart`, `onStepFinish`, `onStepError`, `foreach-sibling`).
- `RunOptions.freezeSnapshots` — opt-in `Object.freeze` of gate snapshots and the warnings array. Defaults to `false`. Covers the snapshot deeply (cycle-safe via `WeakSet`).
- `{ id }` option on `step(agent, …)`, `branch(…)`, `foreach(…)`, `repeat(…)` — disambiguates duplicate `(type, id)` pairs.
- Multi-finally chains: `.finally().finally()` now compiles. Both bodies run; errors aggregate.
- `loadState`'s id-scan fallback now also accepts `Infinity` and fractional `resumeFromIndex` as "corrupted" (in addition to `-1`, `NaN`, out-of-bounds), routing to the by-id scan.
- Construction-time reservation of the `::pipeai::` namespace for synthetic step ids — required to ship F1's `CHECKPOINT_STEP_ID` cleanly.

### Removed

- `WorkflowSuspended` class (see migration).

### Verification

- 156 tests pass (`npm test`).
- All gate tests rewritten to assert on `result.status === "suspended"` instead of `try/catch (e instanceof WorkflowSuspended)`.

## [0.2.1] - 2026-04-27

### Fixed
- Tool input schema was passed under the v3/v4 `parameters` key inside `tool()` calls. AI SDK v5+ expects `inputSchema`; the old key was silently dropped, so every tool built via `defineTool()` or `Agent.asToolProvider()`/`asTool()` reached the model without a schema and was called with `{}`. Renamed the key in both `ToolProvider.createTool()` and `Agent.createToolInstance()`.

### Changed
- Replaced `as any` casts in `tool()` calls with narrowly-scoped `as unknown as Tool<TInput, TOutput>` casts. Catches future SDK key renames at compile time instead of letting them silently break tools.
- `ToolProviderConfig.providerOptions` is now typed as the SDK's `Tool["providerOptions"]` instead of `unknown`.
- `ToolProviderConfig.output` renamed to `outputSchema` to match the v6 `Tool` type. The previous name was silently dropped by AI SDK v6 anyway, so any caller relying on it was already broken.

### Added
- Behavioral regression test that asserts a subagent's input schema reaches the parent model as a populated `JSONSchema7` (not `{}`).
- Direct test for `Agent.asToolProvider()` covering the same `inputSchema` forwarding contract as `asTool()`.

## [0.2.0] - 2026-03-30

### Added
- `gate(id, opts?)` — human-in-the-loop suspension points that throw `WorkflowSuspended` with a JSON-serializable snapshot
- `loadState(gateId, snapshot)` — type-safe workflow resumption; the gate ID string literal infers the response type from a compile-time `TGates` type map
- `ResumedWorkflow` class with typed `generate()` and `stream()` that accept the gate response
- `WorkflowSuspended` error class with a `snapshot` property containing the gate payload and pre-gate output
- `WorkflowSnapshot` interface for serializing/deserializing suspension state
- Gate options: `payload` (custom data for the human), `schema` (runtime response validation via any `.parse()` provider), `condition` (conditional suspension), `merge` (combine pre-gate output with response)
- Compile-time duplicate gate ID detection via conditional type constraint
- Runtime gate ID mismatch validation between `loadState` call and snapshot
- Descriptive error when gates are used inside nested workflows, `foreach()`, or `repeat()`
- Nested workflows — pass a `Workflow` or `SealedWorkflow` as a step via `step(workflow)`
- `foreach()` for iterating arrays through an agent or workflow, with optional `concurrency`
- `repeat()` for conditional loops with `{ until }` or `{ while }` (mutually exclusive, enforced at compile time)
- `WorkflowLoopError` thrown when `maxIterations` is exceeded (default: 10), catchable by `.catch()`
- `writer` automatically available in agent callbacks (`onStepFinish`, `onFinish`, `onError`) when running inside a streaming workflow
- `writer` available in `defineTool` execute via the third parameter when running inside a streaming workflow
- Automatic sub-agent streaming — `asTool()` uses `stream()` and merges to the parent writer when inside a streaming workflow, falls back to `generate()` otherwise
- `asToolProvider()` for deferred context resolution in agent-as-tool composition
- `Workflow.create({ id })` — optional workflow identifier, propagated through all builder methods
- `lastOutput` field in `catch()` callback (renamed from `input` for clarity)
- Runtime guard on `step(id, fn)` — throws if second argument is not a function
- `WorkflowBranchError` with `branchType` property for distinguishing predicate vs select failures
- `RepeatOptions`, `LoopCondition`, `ToolExecuteOptions` exported types

### Changed
- `SealedWorkflow` and `Workflow` now carry a 4th type parameter `TGates` for type-safe gate resumption
- Agent config now passes through all AI SDK `streamText`/`generateText` options (e.g. `temperature`, `maxTokens`, `maxRetries`, `headers`, `prepareStep`, `onChunk`)
- `toolChoice` and `stopWhen` are now `Resolvable` — accept static values or `(ctx, input) => value`
- `SealedWorkflow` exported as type only (cannot be constructed externally)

## [0.1.1] - 2026-03-17

### Changed
- Updated repository URL to `https://github.com/MOSMekawy/pipeai`
- Enabled manual triggering of the publish workflow (`workflow_dispatch`)

## [0.1.0] - 2026-03-16

### Added
- `Agent` — typed wrapper over AI SDK's `generateText`/`streamText` with resolvable config, context-aware tools, and structured output
- `Workflow` — typed pipeline builder with `step()`, `branch()`, `catch()`, and `finally()`
- `defineTool` — context-aware tool factory that injects runtime context into tool `execute` calls
- `asTool()` — compile an agent into a standard AI SDK `Tool` for use in another agent's tool loop
- Predicate branching (`branch([...cases])`) and key-based routing (`branch({ select, agents })`)
- Per-step hooks: `mapGenerateResult`, `mapStreamResult`, `onGenerateResult`, `onStreamResult`, `handleStream`
- Streaming support with automatic stream merging across pipeline steps
- `Workflow.from(agent)` shorthand for single-agent workflows
- `WorkflowBranchError` for unmatched branches
