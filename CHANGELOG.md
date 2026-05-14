# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
