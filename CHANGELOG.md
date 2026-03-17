# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
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
- Agent config now passes through all AI SDK `streamText`/`generateText` options (e.g. `temperature`, `maxTokens`, `maxRetries`, `headers`, `prepareStep`, `onChunk`)
- `toolChoice` and `stopWhen` are now `Resolvable` — accept static values or `(ctx, input) => value`
- `SealedWorkflow` exported as type only (cannot be constructed externally)

## [0.1.1] - 2026-03-17

### Changed
- Renamed package from `agent-workflow` to `pipeai`
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
