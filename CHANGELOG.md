# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-05-20

A correctness, types, and ergonomics release addressing the 30 findings from a multi-agent review of the 0.3.0 codebase. See `docs/superpowers/plans/2026-05-20-review-fixes.md` for the full plan.

### Breaking changes

- **`gate()` now has a third generic `TMerged`.** When you supply a `merge` callback, its return type becomes the workflow's downstream `TOutput`. Previously `merge` was forced to return `TResponse`, which contradicted the documented use case of combining pre-gate output with the human response into a new shape. Existing code without `merge` is unaffected (default `TMerged = TResponse`). Code that relied on the old constraint may need to tighten or loosen the downstream step's input annotation.
- **`BranchSelect.agents` is now typed `Record<TKeys, Agent<TContext, TOutput, TNextOutput>>`** (was `Agent<TContext, any, TNextOutput>`). Mismatched-input agents that previously compiled silently now fail at compile time — this is the intended catch. Update the agent or the `select` return type.
- **`WorkflowSnapshot` and `WorkflowSuspended` are now generic in `TPayload`** (default `unknown`, so existing references compile unchanged). New: cast the caught error to `WorkflowSnapshot<MyPayload>` to narrow `gatePayload` without losing type safety.
- **`extractOutput` (via Agent behavior) now throws** when an `output` schema is declared but the model returned no structured value. Previously it silently fell back to raw text — typed agents acting as tools would receive unstructured strings where typed objects were expected. Catch via the agent's `onError` or wrap the call site.

### Added

- **`AgentConfig.validateOutput?: ZodType<TOutput>`** — optional Zod schema for runtime validation of the model's structured output. Distinct from `tool.outputSchema` (which validates tool execution output).
- **`Agent.generate(ctx, input, options?)` and `Agent.stream(...)` accept `{ abortSignal }`** as an optional second arg. Threads through to the AI SDK and to sub-agents invoked via `asTool`.
- **`Agent.asTool` and `asToolProvider` now forward `ToolExecutionOptions.abortSignal`** from the parent SDK loop to the sub-agent. Parent timeouts and user-driven aborts now correctly cancel sub-agents.
- **`AggregateError` from concurrent `foreach`** — when `concurrency > 1` and multiple items fail, all failures are surfaced via `AggregateError` instead of only the first. When `onError` is set, every failure's handler is invoked; handler throws are collected into a secondary `AggregateError`.
- **`BranchSelect.onUnknownKey?: (params: { key, availableKeys, ctx }) => void`** — diagnostic hook fired when `select` returns a key not in `agents`. Runs even when a `fallback` exists.
- **`Workflow.step(id, nestedWorkflow)` overload** — give nested workflows explicit IDs instead of collapsing to `"nested-workflow"`. Multiple anonymous nested workflows are now distinguishable in catch handlers.
- **`ToolProvider` and `isToolProvider` exported** from `pipeai` (was: only `defineTool`). Enables `instanceof` checks and typed variable declarations.
- **`defer<T>()` and `createToolCallingMockModel`** added to test helpers — deterministic concurrency barriers and tool-call streaming simulation.
- New tests covering abort signal forwarding, tool-call finish reasons, stream-mode hooks (`onStreamResult`, `mapStreamResult`), gate schema validation in stream resumption, and the `validateOutput` end-to-end pipeline.

### Changed

- **`foreach` concurrent path is now a worker pool** (`O(concurrency)` memory) instead of pre-allocating one async closure per item (`O(N)` memory). For 100k-item arrays, memory usage no longer grows with input size.
- **`finally` and `catch` handlers that themselves throw now preserve the original error as `.cause`** instead of silently shadowing it. Both errors are observable; debugging is no longer destructive.
- **`outputPromise.catch(() => {})` suppression in workflow streams is now conditional on `options.onError`** — consumers who provide an error sink keep the silent suppression; consumers who omit both `output` await and `onError` now see the unhandled rejection (no more silent error drops).
- **SDK boundary casts in `Agent`** replaced `as any` with `as unknown as Parameters<typeof generateText>[0]` (and `streamText`). The cast is genuinely narrower than `any`; future SDK option changes will surface at compile time instead of being silently `any`-tainted.
- Five timing-fragile tests refactored to use deferred-promise barriers instead of `setTimeout`-coordinated state machines. Test suite is now deterministic across multiple runs.
- The README sections on gate `merge` and snapshot shape now document the new generics and merge return-shape semantics.

### Fixed

- `Agent.stream()` now wraps synchronous SDK throws so the user's `onError` is invoked. Previously only async errors during streaming flowed through `onError`; immediate provider rejections bypassed it.
- Gate `condition` and `payload` callbacks are now captured by the workflow's `pendingError` plumbing, so a throwing gate routes through `.catch()` like any other step (`WorkflowSuspended` still re-throws normally).
- `WorkflowSuspended` is no longer caught and re-classified as a "step error" when thrown from inside the new gate try/catch.

### Removed

- The internal `Semaphore` import from `src/workflow.ts` (no longer used by the new worker-pool `foreach`). `Semaphore` remains exported from `src/utils.ts` as public API.

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
