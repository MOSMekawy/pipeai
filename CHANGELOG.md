# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **`fromSdkAgent(agent, { mapInput, hasOutput?, validateOutput?, id? })`** — adapt a Vercel AI SDK v7 agent (`ToolLoopAgent` / any value implementing the SDK `Agent` interface) into a `Workflow.step(...)` target. Bridges pipeai's positional `(ctx, input)` call convention to the SDK agent's single `{ prompt | messages }` object. The SDK agent fixes its `runtimeContext` / tools at construction, so pipeai's per-call `ctx` only reaches `mapInput`.
- **`AgentLike<TContext, TInput, TOutput>` interface** — the minimal surface a workflow step needs from an agent (`id`, `hasOutput`, `validateOutput?`, `generate`, `stream`). `Agent` now implements it, and `Workflow.step()` / `Workflow.from()` accept it, so native agents and `fromSdkAgent(...)` adapters are interchangeable step targets.

### Docs

- Documented that AI SDK v7's `toolApproval` passes through a pipeai `Agent` (auto approve/deny policy works with no new code), and the `agent → gate → agent` pattern for durable human-in-the-loop approval.

## [1.0.0] - 2026-06-28

### Changed

- **Migrated to Vercel AI SDK v7 (`ai` peer `^6` → `^7`); dropped v6 support.** AI SDK v7 is **ESM-only** and requires **Node.js ≥ 22** — pipeai inherits both. The package is now ESM-only as well: the CommonJS build (`dist/index.cjs` and the `require` export condition) has been removed, since a CJS bundle cannot `require()` the ESM-only `ai@7`. Consumers needing AI SDK v6 should stay on the pipeai 0.9.x line.
- **Agent config fields renamed to mirror v7's vocabulary** (the SDK renamed these; pipeai is a thin typed passthrough, so it follows):
  - `system` → `instructions`
  - `onFinish` → `onEnd`
  - `onStepFinish` → `onStepEnd`

  `WorkflowStreamOptions.onFinish` → `onEnd` likewise. The `WorkflowObservability` hooks (`onStepStart` / `onStepFinish` / `onStepError`) are **unchanged** — they are pipeai's own per-workflow-step lifecycle vocabulary, not SDK passthrough.
- **zod peer narrowed to `^3.25.76 || ^4.1.8`** to match ai@7's requirement (was `>=3.0.0 || >=4.0.0`).

### Migration notes (consumer-facing AI SDK v7 behavior changes pipeai relays)

The raw SDK result is passed to your `onEnd` / `onStepEnd` / step `mapResult` / `onResult` / `asTool` `mapOutput` hooks, so these v7 semantics now apply:

- The result's `usage` / `content` / `toolCalls` / `toolResults` / `sources` are now **cumulative across all steps** (previously final-step-only). Use `result.finalStep` for last-step-only values; `result.totalUsage` is deprecated in favor of `result.usage`.
- System-role messages embedded in a `messages[]` array are **rejected by default**. Put system text in the agent's `instructions` field (or pass `allowSystemInMessages: true` through to the SDK).
- A passthrough `onChunk` callback now fires for **every** stream-part type; guard on `chunk.type`.
- Internally, the agent stream-merge moved from the deprecated `result.toUIMessageStream()` instance method to the top-level `toUIMessageStream({ stream })` helper.

## [0.9.0] - 2026-06-12

### Added

- **`foreach` per-item path builder: `foreach(path => path.step(a).step(b), opts)`.** A callback target form that receives a sub-builder seeded with the array's element type and returns the built per-item path. Each item runs that whole chain as one concurrent unit (item 0 can be at the last step while item 1 is at the first); the only barrier is collecting the result array at the end. Pure sugar over passing a pre-built `SealedWorkflow` — same behavior, but the element type is inferred so you skip the `Workflow.create<Ctx, Item>()` boilerplate. A gate in the per-item path is forbidden at build time, same as any `foreach` body.
- **`gate`'s `merge` may now produce an output type distinct from the gate response (`TMerged`).** `gate<TResponse, TMerged>(...)` gains a second type param, defaulted to `TResponse` (non-breaking): the merged value becomes the gate's downstream output, while the type `loadState` validates as the resume response stays `TResponse`. Lets a `merge` fold the response into a combined shape (e.g. `{ ...priorOutput, response }`) without forcing the output type to lie. With no `merge` the output is still the (schema-validated) response.
- **`WorkflowStreamResult.stream` is now typed over the run's UI message chunk shape.** `Workflow.stream<UI_MESSAGE>(...)` / `ResumedWorkflow` / `CheckpointResumedWorkflow` thread `UI_MESSAGE` into the result, so `stream` is `ReadableStream<InferUIMessageChunk<UI_MESSAGE>>` instead of a bare `ReadableStream`. `UI_MESSAGE` defaults to `UIMessage`, so existing `WorkflowStreamResult<TOutput>` annotations and call sites are unaffected.

### Changed

- **An abort flowing through a nested workflow / `repeat` / `foreach` / `parallel` step no longer reports a phantom step failure.** When the abort signal fires mid-child-run, the child rethrows `signal.reason` and the wrapping step parks it — which previously fired `onStepError` for that wrapper step (and recorded a duplicate warning), so an observer saw the abort blamed on a user step *in addition to* the run's rejection with the same reason. The run loop now recognizes a newly-parked error that **is** the abort reason as cancellation, not step-logic failure: no step-level `onStepError` / `onStepFinish` for the wrapper, and no duplicate abort-reason warning. The run still rejects with `signal.reason`, and a genuine step error that merely *precedes* an abort still reports `onStepError` normally. **Heads-up:** observers that relied on seeing an `onStepError` for the nested / looped / concurrent wrapper step on abort will no longer receive it (they still get the run's rejection and any per-item `onItemError`).

### Fixed

- **`foreach(path => …)` per-item paths now fire step-level observability.** The callback form built its per-item path from a fresh builder with no observability, so steps inside it never fired `onStepStart` / `onStepFinish` / `onStepError` — and unlike a pre-built `SealedWorkflow` target, the caller had no `create()` of their own to attach hooks to. The parent workflow's observability is now forwarded into the per-item path, so its inner steps are observed under the same hooks (distinct from the `foreach`'s own per-item `onItem*` events).
- **A throwing agent `onError` on the stream path can no longer surface as an unhandled rejection.** `invokeOnError` rethrows when the user handler throws (to preserve the original model error as `cause`); on the stream path it ran inside the AI SDK's `onError` callback, which has no error channel, so that rethrow could escape as an unhandled rejection rather than reaching the consumer. It is now caught and logged on the stream path, keeping the diagnostics intent without the dangling rejection. (The generate path, which already propagates the rethrow to its caller, is unchanged.)
- **`checkpointEvery` / `checkpointWhen` set without an `onCheckpoint` sink now warns.** Cadence options are a silent no-op without a sink, which usually means a forgotten `onCheckpoint`; `validateRunOptions` now emits a one-time warning instead of doing nothing. The mutually-exclusive and positive-integer checks for these options also run now regardless of whether a sink is present.

### Internal

- **Run-loop engine consolidated onto the `Step` class.** The structural `StepNode` union was removed; the run loop consumes `ReadonlyArray<Step>` and dispatches via `node.shouldSkip()` / `node.execute()` directly, so each kind's skip policy lives once on its subclass instead of being mirrored in the loop. `execute()`'s abort-promotion, checkpoint, and precedence-tail blocks were extracted into helpers, and the (previously byte-identical) `foreach` / `parallel` dispatch loop is now shared via `dispatchUnits`. Error classes and the reserved `::pipeai::` step ids moved to a leaf `errors.ts`, and `RuntimeState` / `PendingError` / `ResumeDescent` moved to `runtime.ts`, breaking the runtime↔workflow type cycle. No public API change beyond the entries above.
- **Raw workflow-engine speed benchmarks added** (`src/__tests__/perf.test.ts`): a deep sequential variety pipeline and a wide `foreach` fan-out, measured with zero-cost agent stubs to isolate orchestration overhead from agent / model cost.

## [0.8.4] - 2026-06-02

### Internal

- **`workflow.ts` split into focused modules** — `runtime.ts` (per-run state construction, observability dispatch, warnings, checkpoint sink), `types.ts` (public type / API surface), and a `steps/` directory of one `Step` subclass per kind — plus fixes from a multi-agent review pass. Internal reorganization only; no public API or behavior change.

## [0.8.3] - 2026-06-01

### Added

- **`foreach` / `parallel` can stream their agents via a per-item `handleStream`.** When the workflow is run with `.stream(...)`, supplying `handleStream` to `foreach`/`parallel` runs each agent item/branch in stream mode and lets you surface its stream to the writer — the same hook shape as a single `.step(agent)`, plus an `itemIndex` (numeric index for `foreach` / tuple `parallel`, key for record `parallel`). Without `handleStream`, agent items run in generate mode: unlike a single step, `foreach`/`parallel` **never auto-merge** (auto-merging N concurrent streams would interleave into a garbled message). `SealedWorkflow` items/branches instead stream transitively via their own steps when the parent streams. `handleStream`'s params gain an optional `itemIndex` everywhere (`number | string`, `undefined` for a single step); `branch` now threads the matched key (select) / case index (predicate) into it. `ParallelOptions` gains a second `TOutput` type param (defaulted, non-breaking) so `handleStream`'s `input` is typed.
- **Conditional steps: `when` / `otherwise` on every `step` form.** `step(agent, …)`, inline `step(id, fn, …)`, and nested `step(workflow, …)` now accept `when?: ({ ctx, input }) => boolean`. When it returns false the step is skipped and its body never runs. With `otherwise?: ({ ctx, input }) => TNextOutput` the skip produces that value (output stays `TNextOutput`); without it the input passes through and the output type widens to `TOutput | TNextOutput` (which collapses to one type for same-shape steps). Skipped steps still fire `onStepStart` / `onStepFinish`; `when` / `otherwise` errors route through `.catch()` like any step error. The nested `step(workflow)` form also gains an `id` override via its new options arg.
- **`WorkflowObservability` is now generic over `TContext`** (default `unknown`). `Workflow.create<Ctx>({ observability })` types `ctx` in every hook (`onStepStart` / `onStepFinish` / `onStepError` / `onItem*`) as `Ctx` instead of `unknown`, so callbacks can read context fields without casting. `input` / `output` stay `unknown` — they differ per step, so only the run-constant `ctx` is typed. Non-breaking: the bare `WorkflowObservability` form still resolves to the previous `unknown`-context shape.
- **Inline `.step(id, fn)` handlers now receive `writer?: UIMessageStreamWriter`** — the same writer the agent steps merge into. In a `.stream(...)` run an inline step can emit `UIMessageChunk` parts (status / data parts) to surface mid-pipeline progress before the terminal agent starts emitting tokens, without dropping out of `Workflow.stream(...)`. `writer` is `undefined` in generate mode (guard with `?.`). Non-breaking — existing `({ ctx, input })` destructures keep working. For ambient access inside step helpers, compose the AI SDK's `createUIMessageStream` directly (`getActiveWriter()` is no longer part of the public API — see Removed).
- **`handleStream` now receives `input: TOutput`** — the typed carry from the prior step. Closes the asymmetry with `mapResult` / `onResult`, which already receive `input` via `AgentResultParams`. Lets consumers read the upstream value inside `handleStream` without round-tripping through `ctx`. Non-breaking — existing destructures (`{ result, writer, ctx }`) keep working.
- **`WorkflowStreamOptions` now surfaces every option the AI SDK's `createUIMessageStream` accepts**, with honest types:
  - `onFinish` is typed as the AI SDK's `UIMessageStreamOnFinishCallback<UI_MESSAGE>` — receives the real payload (`messages`, `responseMessage`, `isAborted`, `isContinuation`, `finishReason?`). Previously the public type was `() => MaybePromise<void>`, hiding all of it and forcing consumers to cast through `unknown`.
  - `originalMessages?: UI_MESSAGE[]` — for chat resumption / continuation flows. Forwarded verbatim; AI SDK assumes persistence mode and assigns a response-message id when provided.
  - `generateId?: IdGenerator` — overrides the response message-id generator. Useful for deterministic IDs in tests or coordinating with a server-side ID space.
- **`WorkflowStreamOptions` is now generic** over `UI_MESSAGE extends UIMessage`, default `UIMessage`. `Workflow.stream` / `ResumedWorkflow.stream` / `CheckpointResumedWorkflow.stream` all accept the same method-local generic, so consumers can pass a narrower `UIMessage<METADATA, DATA_PARTS, TOOLS>` and have `onFinish`'s `responseMessage` / `messages` narrow accordingly. Existing call sites continue to compile against the `UIMessage` default.

### Changed

- **`foreach` and `parallel` now default to unbounded concurrency.** When `concurrency` is omitted, both run every item/branch concurrently (clamped only by item/branch count) instead of `foreach`'s old sequential default (`1`) and `parallel`'s old `min(branches.length, 5)` cap. The `parallel` cap removal also drops its one-time "capped at concurrency 5" warning. **Heads-up:** the prior defaults guarded against provider rate limits — pass an explicit integer `concurrency` to throttle large fan-outs (a `foreach` over N items now fires N concurrent calls by default).

### Removed

- **`getActiveWriter` is no longer exported from `pipeai`** (was added to the public surface in 0.8.0). It remains the internal mechanism that powers the writer hand-off, but is no longer a supported extension point. Reach the writer through the explicit paths instead: `defineTool` / `ToolProvider` inject `writer` into `execute(input, ctx, { writer })`, agent `onStepFinish` / `onFinish` / `onError` callbacks receive it, and inline `Workflow.step(id, fn)` handlers receive it. A hand-rolled `IToolProvider` (not built via `defineTool` / `ToolProvider`) that needs the writer should wrap its definition in `ToolProvider`/`defineTool`, which performs the injection.

### Fixed

- **`parallel` now propagates `abortSignal` into its branches.** Branch state was created without the abort signal, so cancellation never reached branch agent/SDK calls or nested-workflow branches, and the worker pool had no pre-launch abort check — every branch fired even on an already-aborted run. `parallel` is now cooperatively cancellable, matching `foreach` / `repeat` (and the `RunOptions.abortSignal` doc now lists `parallel`).
- **`foreach` / `parallel` no longer route cancellation through `onError`.** When the run is aborted, a skipped/aborted branch was being fed to `onError` as an ordinary failure, letting recovery logic "recover" from a cancellation and pollute results. Both combinators now bypass `onError` on abort and rethrow the abort reason (mirroring `repeat`); failures collected before the abort are preserved as warnings.
- **`parallel` output types are now honest about `SKIP`.** Supplying `onError` (the only way a branch can `SKIP`) widens the output values to `BranchOutput | undefined` in both the record and tuple forms, instead of typing a possibly-`undefined` slot as a guaranteed value. Without `onError` the output stays precise.
- **`ResumedWorkflow` now validates `RunOptions`.** Gate-resume via `loadState(...).generate/stream(...)` previously skipped `validateRunOptions`, so invalid combos (mutually-exclusive `checkpointEvery` + `checkpointWhen`, non-positive values, the catastrophic freeze guard) went unchecked on that one entry point. It now validates like every other entry.
- **`catch()` is allowed after a gate-only workflow.** The precondition required a preceding `step`, rejecting `.gate(...).catch(...)` — even though a throwing gate `condition`/`payload` is routed as a `source: "step"` error that `catch` is meant to handle. A preceding `gate` now qualifies.
- **Checkpoint cadence counts executable steps, not raw indices.** The numeric `checkpointEvery` modulo used the raw loop index, so interleaved `catch`/`finally` nodes drifted the "every N executable steps" contract (and could skip checkpointing entirely). It now counts completed executable step bodies.
- **`foreach` validates `concurrency`.** A `NaN` concurrency silently processed nothing (it slipped past the sequential branch into a zero-worker pool); `0`/negative "worked by accident." `foreach` now throws unless `concurrency >= 1` (or `Infinity`).
- **`repeat` validates `maxIterations`.** A non-positive `maxIterations` (e.g. `0`) previously made the loop a silent no-op; it now throws `repeat: maxIterations must be a positive integer`.
- **An abort is no longer swallowed by a terminal `.catch()`.** Aborts are re-promoted at the top of each iteration so a `.catch()` can't resume a pipeline mid-flight — but a `.catch()` that was the *last* node had no subsequent iteration to re-promote it, so it could "recover" the abort and let the run report `complete`, while the same workflow with a trailing `.finally()` correctly rejected. The run now re-promotes a cleared abort in the tail: a terminal `.catch()` may still *observe* the abort (for logging/cleanup), but the run rejects with `signal.reason` regardless of catch position. (The `RunOptions.abortSignal` doc no longer claims `.catch()` can recover from an abort.)
- **`parallel` validates `concurrency`.** Mirrors `foreach`: a `NaN` concurrency previously slipped past the internal `Number.isFinite()` check and silently became full fan-out (the cap removed), while `0`/negative were silently clamped to `1`. `parallel` now throws unless `concurrency >= 1` (or `Infinity`).
- **Checkpoint auto-cadence no longer counts `gate` nodes in its denominator.** The default cadence is `ceil(stepCount / 4)`, but `gate` nodes never reach the checkpoint block (they suspend/skip), so the runtime counter never advanced on them — gates inflated the denominator and diluted checkpoint frequency below the intended ~4 across the run. The denominator now counts only checkpointable (`type: "step"`) nodes, matching the runtime counter. (Explicit `checkpointEvery` is unaffected.)
- **Synthetic step ids moved into the reserved `::pipeai::` namespace.** The cancellation marker (`abort`) and gate-resume merge/validate marker (`gate:resume`) were plain strings, so a user step legitimately named `"abort"` was indistinguishable from the abort marker in warnings / observability / `.catch()`. They are now `::pipeai::abort` and `::pipeai::gate:resume` — the same reserved namespace `CHECKPOINT_STEP_ID` already used and that user step ids are forbidden from. Both are exported (`ABORT_STEP_ID`, `GATE_RESUME_STEP_ID`) so observers can match without hardcoding the literal.
- **A throwing gate now fires `onStepError` with `type: "gate"`.** A gate whose `condition` / `payload` callback threw routed the error straight into the pipeline without firing the `onStepError` observability hook — breaking telemetry/tracing for gate failures, even though the contract promised it (an observer only ever saw `onStepStart`). The gate failure now fires `onStepError` with `type: "gate"` (and attaches a throwing hook's error as `cause`, like the step path). The pending error is also tagged `source: "gate"` so the suspension-wins tail reports `type: "gate"` instead of `"step"`.
- **`WorkflowWarning.source` now includes the per-item hook sources.** A throwing `onItemStart` / `onItemFinish` / `onItemError` hook pushed a warning whose `source` was the hook name — a value the exported `WorkflowWarning.source` union didn't list, hidden behind an `as` cast, so an exhaustive `switch (w.source)` silently missed them. The union now includes `"onItemStart"` / `"onItemFinish"` / `"onItemError"` (and `"gate"`, for a demoted gate error), and the cast is gone so the type checker enforces it.
- **`freezeSnapshots: true` no longer freezes the live pipeline value on the checkpoint path.** The checkpoint snapshot's `output` aliased `state.output`, and `deepFreeze` recursed into it — but unlike a gate (which suspends), a checkpoint keeps executing, so the next step received a frozen input and any in-place mutation threw `object is not extensible` (or silently no-op'd with freeze off). The checkpoint snapshot now freezes an independent `structuredClone` of the output, leaving the live value mutable. (The gate path is unchanged — it stops execution, so its freeze was already harmless.)
- **`freezeSnapshots: true` now freezes `result.warnings` on the complete path too.** The freeze was gated on suspension, so a completed run returned an unfrozen warnings array despite the documented contract ("deeply freeze the gate / checkpoint snapshot **and the `result.warnings` array**"). It now freezes on both terminal paths.
- **`foreach` / `parallel` reject fractional `concurrency`.** A value like `2.5` passed the `>= 1` check and was then silently floored by the worker-pool `Array.from({ length })`. Both now require a positive integer or `Infinity`, matching the `maxIterations` / `checkpointEvery` validation. (Error message changed from "must be >= 1" to "must be a positive integer or Infinity".)
- **`repeat` validates that exactly one of `until` / `while` is supplied.** A type-bypassed caller passing neither (or both) previously hit a confusing `options.while is not a function` TypeError inside the loop body; it now throws `repeat: requires exactly one of` up front.

### Documentation

- **`RunOptions.checkpointTimeout`** now documents that a timeout abandons the *await*, not the *work*: the callback's `AbortSignal` fires, but JS can't forcibly cancel an in-flight promise, so a callback that ignores the signal still completes its side effect. Honor the passed `signal` to make the timeout real.
- **`RepeatOptions`** now documents that both `until` and `while` are **do-while** — the body always runs at least once before the predicate is checked (the predicate needs the body's `output`), so `while: () => false` still executes the body once.

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
