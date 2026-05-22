# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

Combines the [fix/review-findings] correctness/ergonomics work with the [F0] suspension-as-return-value redesign that landed on master in 0.4.0. Headed for a 0.5.0 release.

### Breaking changes (in addition to all of 0.4.0)

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
