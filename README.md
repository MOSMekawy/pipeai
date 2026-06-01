# pipeai

A typed multi-agent workflow pipeline built on top of the [Vercel AI SDK v6](https://sdk.vercel.ai/). It provides two core primitives — **Agent** and **Workflow** — that compose into declarative, streamable AI pipelines with shared context and typed outputs.

Agents are pure AI SDK wrappers that return native `GenerateTextResult` / `StreamTextResult`. Workflows chain agents into pipelines with automatic stream merging, deterministic agent routing, and typed output extraction.

The library is ~1000 lines across 4 files. It's designed to be read, understood, and modified — a thin composition layer over AI SDK, not a framework to learn around.

## Core Concepts

| Primitive      | Purpose                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `Agent`        | A pure AI SDK wrapper. Supports `generate()`, `stream()`, `asTool()`, and `asToolProvider()`. |
| `Workflow`     | A typed pipeline that chains agents with `step()`, `branch()`, `foreach()`, `repeat()`, `gate()`, `catch()`, and `finally()`. |
| `defineTool`   | A context-aware tool factory — injects runtime context into tool `execute` calls.                     |

## Installation

```bash
npm install pipeai
```

Peer dependencies:

```json
{
  "peerDependencies": {
    "ai": "^6.0.0",
    "zod": ">=3.0.0 || >=4.0.0"
  }
}
```

## Agent

An `Agent` wraps AI SDK's `generateText` / `streamText` with typed context, input, and output. It returns native AI SDK result types — no custom wrappers to learn.

### Defining an agent

```ts
import { Agent } from "pipeai";
import { openai } from "@ai-sdk/openai";

type Ctx = {
  userId: string;
  db: Database;
};

const assistant = new Agent<Ctx, string>({
  id: "assistant",
  model: openai("gpt-4o"),
  system: "You are a helpful assistant.",
  prompt: (ctx, input) => input,
  tools: { search, writeFile },
});
```

### Running an agent

```ts
// Non-streaming — returns native GenerateTextResult
const result = await assistant.generate(ctx, "Help me refactor the auth module");
result.text;         // string
result.usage;        // LanguageModelUsage
result.steps;        // step history
result.toolCalls;    // tools that were called

// Streaming — returns native StreamTextResult
const result = await assistant.stream(ctx, "Explain quantum computing");
for await (const chunk of result.textStream) {
  process.stdout.write(chunk);
}
```

### Structured output

```ts
import { Output } from "ai";
import { z } from "zod";

const classificationSchema = z.object({
  priority: z.enum(["low", "medium", "high", "critical"]),
  category: z.string(),
  summary: z.string(),
});

const classifier = new Agent<Ctx, { title: string; body: string }>({
  id: "classifier",
  input: z.object({ title: z.string(), body: z.string() }),
  output: Output.object({ schema: classificationSchema }),
  model: openai("gpt-4o-mini"),
  system: "Classify support tickets.",
  prompt: (ctx, input) => `Title: ${input.title}\n\nBody: ${input.body}`,
});

const result = await classifier.generate(ctx, { title: "App crash", body: "Crashes on save" });
result.output; // { priority: "high", category: "bug", summary: "..." }
```

### Dynamic configuration (Resolvable)

Most config fields accept a static value or a `(ctx, input) => value` function:

```ts
const agent = new Agent<Ctx, string>({
  id: "adaptive",
  model: (ctx) => ctx.isPremium ? openai("gpt-4o") : openai("gpt-4o-mini"),
  system: (ctx) => `You assist ${ctx.userName}. Role: ${ctx.role}.`,
  tools: (ctx) => {
    const base = { search: searchTool };
    if (ctx.isAdmin) return { ...base, deleteUser: deleteUserTool };
    return base;
  },
  prompt: (ctx, input) => input,
});
```

### AI SDK callbacks

Same callback names as AI SDK v6, extended with `ctx`, `input`, and `writer`. The AI SDK event payload is available as `result`. When the agent runs inside a streaming workflow, `writer` is available for writing metadata or custom stream parts:

```ts
const agent = new Agent<Ctx, string>({
  id: "monitored",
  model: openai("gpt-4o"),
  prompt: (ctx, input) => input,
  onStepFinish: ({ result, ctx, writer }) => {
    console.log(`Step done, used ${result.usage.totalTokens} tokens`);
    // Stream progress metadata to the client
    writer?.write({ type: "metadata", value: { tokensUsed: result.usage.totalTokens } });
  },
  onFinish: ({ result, ctx }) => {
    console.log(`Total: ${result.totalUsage.totalTokens} tokens`);
  },
  onError: ({ error, ctx }) => {
    ctx.logger.error("Agent failed", error);
  },
});
```

### Configuration options

| Option        | Type                      | Description                                                       |
| ------------- | ------------------------- | ----------------------------------------------------------------- |
| `id`          | `string`                  | Agent identifier.                                                 |
| `description` | `string`                  | Agent description (used by `asTool()` for tool description).      |
| `input`       | `ZodType`                 | Input schema. Required for `asTool()`. Infers `TInput`.           |
| `output`      | `Output`                  | AI SDK Output (e.g. `Output.object({ schema })`). Infers `TOutput`. |
| `validateOutput` | `ZodType<TOutput>`     | Optional runtime guard. Validates the structured `output` after the SDK parses it (distinct from `tool.outputSchema`). Catches SDK-side parse drift. |
| `model`       | `Resolvable`              | Language model. Static or `(ctx, input) => model`.                |
| `system`      | `Resolvable`              | System prompt.                                                    |
| `prompt`      | `Resolvable`              | String prompt. Mutually exclusive with `messages`.                |
| `messages`    | `Resolvable`              | Message array. Mutually exclusive with `prompt`.                  |
| `tools`       | `Resolvable`              | Tool map. Supports `Tool`, `ToolProvider`, and `agent.asTool()`.  |
| `activeTools` | `Resolvable`              | Subset of tool names to enable.                                   |
| `toolChoice`  | `Resolvable`              | Tool choice strategy. Static or `(ctx, input) => toolChoice`.     |
| `stopWhen`    | `StopCondition` &#124; `StopCondition[]` | Condition(s) for stopping the tool loop. **Static only** — not a `Resolvable`. A bare function is ambiguous with the resolver form, so dynamic stop conditions require building the agent per call. |
| `onStepFinish`| `({ result, ctx, input, writer? })`| Called after each step. `writer` available in streaming workflows. |
| `onFinish`    | `({ result, ctx, input, writer? })`| Called when all steps complete.                                   |
| `onError`     | `({ error, ctx, input, writer? })` | Called on error.                                                  |
| `...`         | AI SDK options            | All other `streamText`/`generateText` options pass through (e.g. `temperature`, `maxTokens`, `maxRetries`, `headers`, `prepareStep`, `onChunk`, etc.). |

## `asTool()` — Agent as Tool

`asTool()` compiles an agent into a standard AI SDK `Tool`. The parent agent's LLM tool loop handles routing — no dedicated router needed.

```ts
const codingAgent = new Agent<Ctx, { task: string; language?: string }>({
  id: "coding",
  description: "Writes and modifies code.",
  input: z.object({
    task: z.string().describe("What code to write"),
    language: z.string().optional(),
  }),
  model: openai("gpt-4o"),
  prompt: (ctx, input) => `Task: ${input.task}`,
  tools: { writeFile, readFile },
});

const qaAgent = new Agent<Ctx, { question: string }>({
  id: "qa",
  description: "Answers technical questions.",
  input: z.object({ question: z.string() }),
  model: openai("gpt-4o"),
  prompt: (ctx, input) => input.question,
  tools: { readFile, search },
});

// Parent agent uses sub-agents as tools
const orchestrator = new Agent<Ctx, string>({
  id: "orchestrator",
  model: openai("gpt-4o"),
  system: "Delegate work to the right specialist.",
  prompt: (ctx, input) => input,
  tools: (ctx) => ({
    coding: codingAgent.asTool(ctx),
    qa: qaAgent.asTool(ctx),
  }),
});

const result = await orchestrator.generate(ctx, "Write a fizzbuzz function in Python");
```

Custom output extraction:

```ts
codingAgent.asTool(ctx, {
  mapOutput: (result) => ({
    text: result.text,
    files: result.steps
      .flatMap(s => s.toolResults)
      .filter(tr => tr.toolName === "writeFile")
      .map(tr => tr.args.path),
  }),
});
```

**Automatic streaming:** When `asTool()` is used inside a streaming workflow, sub-agents automatically use `stream()` and merge their output to the parent's stream — the user sees sub-agent responses in real-time. Outside of a streaming context (standalone use or generate mode), `asTool()` falls back to `generate()`. This is handled invisibly — no configuration needed.

## `asToolProvider()` — Deferred Context

`asTool(ctx)` bakes the context in at call time. `asToolProvider()` defers context resolution — the tool is created with the correct context when another agent's tool resolution runs:

```ts
const orchestrator = new Agent<Ctx, string>({
  id: "orchestrator",
  model: openai("gpt-4o"),
  system: "Delegate work to the right specialist.",
  prompt: (ctx, input) => input,
  tools: {
    // Context resolved when the orchestrator's tools are resolved
    coding: codingAgent.asToolProvider(),
    qa: qaAgent.asToolProvider(),
  },
});
```

This is useful when the agent is defined at module scope but the context isn't available until runtime. `asToolProvider()` returns an `IToolProvider` — the same interface used by `defineTool`.

## defineTool — Context-Aware Tools

`defineTool` wraps a tool definition so the agent's runtime context is injected into every `execute` call. The `input` field maps to AI SDK's `inputSchema`. When running inside a streaming workflow, the `writer` is automatically available in the third parameter for streaming metadata or progress updates to the client:

```ts
import { defineTool } from "pipeai";

type Ctx = { db: Database; userId: string };

const define = defineTool<Ctx>();

const searchOrders = define({
  description: "Search user orders",
  input: z.object({ query: z.string() }),
  execute: async ({ query }, ctx, { writer }) => {
    writer?.write({ type: "metadata", value: { status: "searching" } });
    const results = await ctx.db.orders.search(ctx.userId, query);
    writer?.write({ type: "metadata", value: { status: "done", count: results.length } });
    return results;
  },
});

const cancelOrder = define({
  description: "Cancel an order by ID",
  input: z.object({ orderId: z.string() }),
  execute: async ({ orderId }, ctx) => {
    return ctx.db.orders.cancel(ctx.userId, orderId);
  },
});

// Mix with plain AI SDK tools freely
const agent = new Agent<Ctx, string>({
  id: "support",
  model: openai("gpt-4o"),
  prompt: (ctx, input) => input,
  tools: { searchOrders, cancelOrder, calculator: plainTool },
});
```

The `writer` is `undefined` when running in generate mode or standalone — `?.` handles both cases naturally.

## Workflow

A `Workflow` chains agents and transformation steps into a typed pipeline. Context is read-only — agents communicate through outputs.

### Building a workflow

```ts
import { Workflow } from "pipeai";

const pipeline = Workflow.create<Ctx>()
  .step(classifier)
  .step("build-prompt", ({ input }) => {
    return `Handle this ${input.priority} ${input.category} ticket: ${input.summary}`;
  })
  .step(supportAgent)
  .step("save", async ({ input, ctx }) => {
    await ctx.db.responses.save(input);
    return input;
  });
```

An inline `.step(id, fn)` handler receives `{ ctx, input, writer? }`. When the workflow runs via `.stream(...)`, `writer` is the same `UIMessageStreamWriter` the agent steps merge into — so an inline step can surface mid-pipeline progress (status/data parts) to the client before the terminal agent starts emitting tokens. `writer` is `undefined` in generate mode (`.generate(...)`), so guard with `?.`:

```ts
const pipeline = Workflow.create<Ctx>()
  .step("plan", async ({ ctx, input, writer }) => {
    writer?.write({ type: "data-status", data: { phase: "planning" } });
    return planner.run(ctx, input);
  })
  .step("search", async ({ ctx, input, writer }) => {
    writer?.write({ type: "data-status", data: { phase: "searching", queries: input.queries.length } });
    return ctx.search.run(input.queries);
  })
  .step(synthesizerAgent); // terminal streaming agent
```

For ambient writer access from helper functions called *inside* a step, compose the AI SDK's `createUIMessageStream` directly — pipeai only threads `writer` into the inline step handler itself.

### Running a workflow

```ts
// Non-streaming — calls agent.generate() at each step
const result = await pipeline.generate(ctx, initialInput);
if (result.status === "complete") {
  console.log(result.output);
} else {
  // result.status === "suspended" — see Human-in-the-Loop section
  await db.saveSnapshot(result.snapshot);
}

// Streaming — calls agent.stream() at each step, merges into a single ReadableStream
const { stream, output } = pipeline.stream(ctx, initialInput);
return new Response(stream);

// output resolves to WorkflowResult<T> — never rejects on suspension
const final = await output;
```

The return value is a `WorkflowResult<T>` discriminated union — either `{ status: "complete", output, warnings }` or `{ status: "suspended", snapshot, warnings }`. `warnings` is always present on both branches (`readonly WorkflowWarning[]`, possibly empty).

### Nested workflows

Workflows can be passed as steps into other workflows. The nested workflow's steps execute within the parent's runtime state — streams merge naturally, and errors propagate to the parent's `catch()`:

```ts
// A reusable sub-workflow
const classifyAndRoute = Workflow.create<Ctx>()
  .step(classifier, {
    // Suppress the classifier's stream — only route the result
    handleStream: async ({ result }) => { await result.text; },
  })
  .branch({
    select: ({ input }) => input.agent,
    agents: { bug: bugAgent, feature: featureAgent },
  });

// Compose into a larger pipeline
const pipeline = Workflow.create<Ctx>()
  .step(classifyAndRoute)  // nested workflow as a step
  .step("save", async ({ input, ctx }) => {
    await ctx.db.save(input);
    return input;
  })
  .catch("fallback", () => "Something went wrong.");
```

Nested workflows can be arbitrarily deep — a workflow step can contain another workflow that itself contains nested workflows.

### Conditional steps via `when` / `otherwise`

Any `step` form — agent, inline `step(id, fn)`, or nested `step(workflow)` — accepts a `when` predicate. When it returns false the step is **skipped** and its body never runs:

```ts
const pipeline = Workflow.create<Ctx, Input>()
  // skip → passthrough: input is forwarded unchanged
  .step(enrichAgent, { when: ({ input }) => input.needsEnrichment })
  // skip → `otherwise` produces the value
  .step("search", runSearch, {
    when: ({ input }) => input.intent === "search",
    otherwise: ({ input }) => ({ ...input, results: [] }),
  })
  // conditionally run a whole sub-pipeline
  .step(productPipeline, { when: ({ input }) => input.intent === "product" });
```

The output type reflects what can actually happen — this is deliberate, so a skipped step can't be mistaken for one that always ran:

- **`when` + `otherwise`** → output stays `TNextOutput` (`otherwise` returns it).
- **`when` without `otherwise`** → output widens to `TOutput | TNextOutput` (skip passes the input through). For same-shape tap/enrich steps the union collapses to a single type; when the shapes differ and you'd rather keep a single type, supply `otherwise` to produce a default.
- **no `when`** → `TNextOutput`, exactly as before.

`when` / `otherwise` throwing propagates as a normal step error (a downstream `.catch()` can observe it). A skipped step still fires the `onStepStart` / `onStepFinish` observability events with its passthrough/`otherwise` value as `output`.

### Predicate branching via `branch()`

Route to different agents based on runtime conditions. The first matching `when` wins. A case without `when` acts as the default:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(classifier)
  .branch([
    { when: ({ ctx }) => ctx.isPremium, agent: premiumAgent },
    { agent: standardAgent }, // default
  ]);
```

All branches must produce the same output type — enforced at compile time. This eliminates the type-safety holes that per-step conditionals create.

### Key-based routing via `branch()`

Route to different agents based on the previous step's output. Type-safe — the `select` return type must match the `agents` keys:

```ts
const classifierOutput = z.object({
  agent: z.enum(["bug", "feature", "question"]),
  reasoning: z.string(),
});

const classifier = new Agent<Ctx>({
  id: "classifier",
  output: Output.object({ schema: classifierOutput }),
  model: openai("gpt-4o-mini"),
  system: "Classify the user's request. Pick the best agent.",
  messages: (ctx) => ctx.chatHistory,
});

const pipeline = Workflow.create<Ctx>()
  .step(classifier)
  .branch({
    select: ({ input }) => input.agent, // must return "bug" | "feature" | "question"
    agents: {
      bug: bugAgent,
      feature: featureAgent,
      question: questionAgent,
    },
  })
  .step("save", async ({ input, ctx }) => {
    await ctx.db.save(input);
    return input;
  });

const { stream } = pipeline.stream(ctx);
return new Response(stream);
```

### Custom output extraction

Separate callbacks for `generate()` vs `stream()` — each receives the correct result type:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(codingAgent, {
    // Called during workflow.generate() — GenerateTextResult (sync access)
    mapGenerateResult: ({ result }) => ({
      text: result.text,
      files: result.steps
        .flatMap(s => s.toolResults)
        .filter(tr => tr.toolName === "writeFile")
        .map(tr => tr.args.path),
    }),
    // Called during workflow.stream() — StreamTextResult (async access)
    mapStreamResult: async ({ result }) => ({
      text: await result.text,
      files: (await result.steps)
        .flatMap(s => s.toolResults)
        .filter(tr => tr.toolName === "writeFile")
        .map(tr => tr.args.path),
    }),
  });
```

### Per-step result access

Access the full AI SDK result at each step — useful for persistence, logging, or analytics without coupling that logic to agent definitions:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(supportAgent, {
    // Called during workflow.generate()
    onGenerateResult: async ({ result, ctx, input }) => {
      await ctx.db.conversations.save(ctx.userId, {
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });
    },
    // Called during workflow.stream()
    onStreamResult: async ({ result, ctx }) => {
      await ctx.db.conversations.save(ctx.userId, {
        role: "assistant",
        content: await result.text,
        toolCalls: await result.toolCalls,
      });
    },
  });
```

### Fine-grained stream control

Override how each agent's stream is merged into the workflow stream. By default, every agent's output is merged via `writer.merge(result.toUIMessageStream())`. Use `handleStream` to take control — the callback receives `{ result, writer, ctx }`:

```ts
const pipeline = Workflow.create<Ctx>()
  // Suppress the classifier's stream — the user shouldn't see
  // the structured classification output, only the final response
  .step(classifier, {
    handleStream: async ({ result }) => {
      await result.text; // consume without forwarding to the client
    },
  })
  // Custom merging — e.g. add metadata annotations to the stream
  .step(supportAgent, {
    handleStream: async ({ result, writer, ctx }) => {
      writer.write({ type: "metadata", value: { agentId: "support", userId: ctx.userId } });
      writer.merge(result.toUIMessageStream());
    },
  });
```

### Array iteration via `foreach()`

`foreach()` maps each element of an array output through an agent or workflow. Items run in generate mode to avoid interleaved streams:

```ts
const summarizer = new Agent<Ctx, string, string>({
  id: "summarizer",
  model: openai("gpt-4o-mini"),
  prompt: (ctx, input) => `Summarize: ${input}`,
});

const pipeline = Workflow.create<Ctx>()
  .step("fetch-articles", async ({ ctx }) => {
    return ctx.db.articles.getRecent(10); // string[]
  })
  .foreach(summarizer)  // output: string[]
  .step("combine", ({ input }) => input.join("\n\n"));
```

Concurrent processing with bounded parallelism:

```ts
// Up to 3 items run simultaneously; the next launches as soon as one finishes.
.foreach(summarizer, { concurrency: 3 })
```

`concurrency` is the **maximum number of items in flight at any moment** — backed by a semaphore. There's no lockstep batching: a slow item never blocks a finished slot from picking up the next pending one.

Works with nested workflows too:

```ts
const processItem = Workflow.create<Ctx, string>()
  .step(analyzeAgent)
  .step(enrichAgent);

const pipeline = Workflow.create<Ctx>()
  .step("fetch-items", async ({ ctx }) => ctx.db.items.getAll())
  .foreach(processItem, { concurrency: 5 });
```

#### Per-item error recovery via `onError`

By default a single item's failure aborts the whole `foreach`. Pass an `onError` handler to recover individual items — return a substitute value, return `Workflow.SKIP` to drop the failed index from the output array, or rethrow to abort the step (the throw is catchable by a downstream `.catch()`):

```ts
import { Workflow } from "pipeai";

const pipeline = Workflow.create<Ctx>()
  .step("fetch", async ({ ctx }) => ctx.db.urls.getAll())
  .foreach(scraper, {
    concurrency: 5,
    onError: ({ error, item, index }) => {
      // Substitute a placeholder
      if (isTransient(error)) return { url: item, body: "" };
      // Or drop the item entirely (output array is shortened)
      return Workflow.SKIP;
    },
  });
```

`onError` is invoked sequentially in **index order** after all items settle, so its observable order is deterministic regardless of completion timing. In-flight siblings are never cancelled by another item's failure.

**Type safety:** `foreach()` uses `ElementOf<TOutput>` to extract the array element type. If the previous step doesn't produce an array, the call is rejected at compile time.

### Fan-out via `parallel()`

`parallel()` runs several branches against the **same input** concurrently and collects their results. Two type-overload forms — record (keyed by name) and tuple (positional):

```ts
// Record form — returns { researcher: ResearchOutput, critic: CriticOutput }
const pipeline = Workflow.create<Ctx, string>()
  .step("classify", classifier)
  .parallel({ researcher, critic });

// Tuple form — returns [ResearchOutput, CriticOutput]
const pipeline = Workflow.create<Ctx, string>()
  .step("classify", classifier)
  .parallel([researcher, critic] as const);
```

The same input (`state.output`) is fed to each branch. Default concurrency is `min(branches.length, 5)` — most users want fan-out, but the cap protects against rate-limit pressure. Pass `concurrency: Infinity` (or `branches.length`) to opt out.

```ts
.parallel({ a, b, c, d, e, f, g, h }, { concurrency: 3 })     // explicit override
.parallel({ a, b, c, d, e, f, g, h }, { concurrency: Infinity })  // full fan-out
```

**Generate mode only.** Streams aren't threaded through to branches — interleaving multiple agent streams into one writer is out of scope.

#### Per-branch error handling

```ts
.parallel({ a, b }, {
  onError: ({ error, key, ctx }) => {
    if (key === "a") return "fallback-a";   // substitute
    if (key === "b") return Workflow.SKIP;  // record form: undefined slot
    throw error;                            // rethrow to abort the parallel
  },
})
```

`onError` is **bypassed** on the suspension path — if any branch hits a nested gate, the marker reaches the caller without onError running. Non-suspension errors flow through onError in branch order.

#### Suspension under parallel

Gates inside parallel branches throw `NestedGateUnsupportedError`, same as `foreach` concurrent. The lowest-index suspending branch wins the marker; others contribute to `siblingSuspensions`. Multi-branch suspension semantics are finalized in F0.6 alongside `cancelOnFirstSuspend` — until then, all branches run to completion (or sibling-failure) before the marker reaches the caller.

> **Rate-limit hazard:** `parallel`'s default `min(N, 5)` assumes ≥5 RPS headroom on your model provider. Symptoms of overflow: 429s and stair-stepped latency.

> **Concurrent ctx-mutation hazard:** branches share the `ctx` object by reference. Treat `ctx` as immutable inside parallel branches.

### Conditional loops via `repeat()`

`repeat()` runs an agent or workflow in a loop until a condition is met. The body's output feeds back as input — same type in, same type out:

```ts
const refiner = new Agent<Ctx, string, string>({
  id: "refiner",
  model: openai("gpt-4o"),
  system: "Improve the given text. Make it clearer and more concise.",
  prompt: (ctx, input) => input,
});

const pipeline = Workflow.create<Ctx>()
  .step("draft", ({ ctx }) => ctx.initialDraft)
  .repeat(refiner, {
    until: ({ output, iterations }) => {
      // Stop when quality is good enough or after 3 iterations
      return output.length < 500 || iterations >= 3;
    },
  });
```

Use `while` for the opposite condition (repeat while true, stop when false):

```ts
.repeat(refiner, {
  while: ({ output }) => output.includes("TODO"),  // keep going while TODOs remain
  maxIterations: 5,  // safety limit (default: 10)
})
```

The `until` and `while` options are mutually exclusive — TypeScript enforces this at compile time.

When `maxIterations` is exceeded, a `WorkflowLoopError` is thrown — catchable by `.catch()`:

```ts
.repeat(agent, { until: () => false, maxIterations: 3 })
.catch("loop-safety", ({ error }) => {
  if (error instanceof WorkflowLoopError) {
    return "Reached iteration limit, returning best result.";
  }
  throw error;
})
```

In stream mode, each iteration streams to the client — the user sees the refinement in real-time.

### Error handling

```ts
const pipeline = Workflow.create<Ctx>()
  .step(classifier)
  .step(supportAgent)
  .catch("fallback", ({ error, ctx, stepId }) => {
    ctx.logger.error(`Step "${stepId}" failed`, error);
    return "Sorry, something went wrong.";
  })
  .finally("cleanup", ({ ctx }) => {
    ctx.metrics.recordPipelineRun();
  });
```

### Stream callbacks

`stream()` accepts the same callbacks as AI SDK's `createUIMessageStream` — `onError` for custom error messages and `onFinish` for post-stream cleanup:

```ts
const { stream, output } = pipeline.stream(ctx, initialInput, {
  onError: (error) => {
    // Return a user-facing error message (default: generic error string)
    console.error("Stream error", error);
    return "An error occurred while processing your request.";
  },
  onFinish: async () => {
    // Called when the stream closes — useful for analytics, cleanup
    await analytics.track("workflow-stream-complete");
  },
});
```

### Builder methods

| Method                    | Description                                                                 |
| ------------------------- | --------------------------------------------------------------------------- |
| `.step(agent, options?)`  | Execute an agent. Options: `mapGenerateResult`, `mapStreamResult`, `onGenerateResult`, `onStreamResult`, `handleStream`. |
| `.step(workflow)`         | Execute a nested workflow. Its steps run within the parent's runtime state. |
| `.step(id, fn)`           | Transform the output. `fn` receives `{ ctx, input }` and returns the new output. |
| `.branch([...cases])`     | Predicate routing. First `when` match wins; case without `when` is default. |
| `.branch({ select, agents })` | Key routing. `select` returns a key, runs the matching agent.          |
| `.foreach(target, opts?)` | Map each array element through an agent or workflow. `opts.concurrency` is the max items in flight (default: 1). `opts.onError` recovers per-item failures; return `Workflow.SKIP` to drop an index. |
| `.repeat(target, opts)`   | Loop an agent or workflow. Use `{ until }` or `{ while }` (mutually exclusive). `maxIterations` defaults to 10. |
| `.gate(id, opts?)`        | Human-in-the-loop suspension point. Returns a result with `status: "suspended"` carrying a serializable snapshot. Resume via `loadState(gateId, snapshot)`. |
| `.catch(id, fn)`          | Handle errors. `fn` receives `{ error, ctx, lastOutput, stepId }` and returns a recovery value. Bypassed on suspension. |
| `.finally(id, fn)`        | Always runs — including after a gate suspends. `fn` receives `{ ctx }`. Throwing finallys no longer abort subsequent ones; errors aggregate into `AggregateError` on the completion path and into `result.warnings` on the suspension path. |

### Output flow

Output flows through the pipeline: each `step()` or `branch()` produces a new output that becomes the next step's `input`. `finally()` preserves the existing output.

Auto-extraction priority for `step()` with an agent:
1. Explicit `mapGenerateResult` / `mapStreamResult` on step options
2. `result.output` if the agent has a structured `output` set
3. `result.text` as fallback

## Two Composition Patterns

| Pattern              | Who decides?          | Streaming?             | Use case                                |
| -------------------- | --------------------- | ---------------------- | --------------------------------------- |
| `asTool()`           | LLM (tool loop)       | Sub-agents don't stream | LLM picks which agent(s) to call, can loop |
| `branch()`           | Deterministic         | Full streaming         | Previous output or runtime conditions determine the next agent |
| `step(workflow)`     | Deterministic         | Full streaming         | Compose reusable sub-workflows into larger pipelines |
| `foreach()`          | Deterministic         | Items don't stream     | Process each element of an array through an agent or workflow |
| `repeat()`           | Condition function    | Each iteration streams | Iterative refinement until a quality threshold is met |

## Human-in-the-Loop via `gate()`

`gate()` suspends a workflow at a designated point, producing a JSON-serializable snapshot. The consumer persists the snapshot, collects human input out-of-band (HTTP, WebSocket, CLI, queue — any transport), then resumes the workflow from where it left off.

> **0.4.0 breaking change:** suspension is a return value, not a thrown error. `generate()` and `stream()` resolve with `WorkflowResult<T>` — a discriminated union of `{ status: "complete", output, warnings }` and `{ status: "suspended", snapshot, warnings }`. `WorkflowSuspended` has been removed. See [Migration from 0.3.x](#migration-from-03x).

### Basic gate

```ts
import { Workflow } from "pipeai";

const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    payload: ({ input }) => ({ draft: input, instructions: "Please review this draft" }),
  })
  .step(publishAgent);

// Run — suspends at gate
const result = await pipeline.generate(ctx, input);
if (result.status === "suspended") {
  await db.saveSnapshot(result.snapshot);
  return res.status(202).json(result.snapshot.gatePayload);
}
// result.status === "complete" here — TS narrows `output` automatically
return res.json({ output: result.output });

// Resume — load state, pass gate ID + snapshot to generate or stream
const snapshot = await db.loadSnapshot(id);
const resumed = pipeline.loadState("review", snapshot);
const resumeResult = await resumed.generate(ctx, humanResponse);
if (resumeResult.status === "complete") {
  console.log(resumeResult.output);
}
```

The `snapshot` is plain JSON — it survives `JSON.parse(JSON.stringify())`, database storage, and process restarts. The workflow definition (code) stays in the process; only the data is serialized.

`result.warnings` is **always** present on both branches — an array of non-fatal errors (a throwing `.finally()`, a misbehaving observer). It's `readonly WorkflowWarning[]`, never `undefined`. If you don't care about non-fatal failures, ignore it.

### Resuming with streaming

For chat applications where the client reconnects and needs a live stream for the remaining steps:

```ts
const resumed = pipeline.loadState("review", snapshot);
const { stream, output } = resumed.stream(ctx, humanResponse);
return new Response(stream);
```

The previous stream is gone — the library only streams forward from the resume point. Load prior chat history from your database and send it to the client before piping the resume stream.

### Streaming suspension

When `stream()` hits a gate, the stream closes cleanly (partial content from steps before the gate is delivered). The `output` Promise **resolves** with `{ status: "suspended", snapshot, warnings }` — it does **not** reject:

```ts
const { stream, output } = pipeline.stream(ctx, input);
pipeStreamToResponse(res, stream); // partial content delivered normally

const result = await output;
if (result.status === "suspended") {
  await db.saveSnapshot(result.snapshot);
}
// Real errors (a step throws something other than a gate suspension) still
// reject the output Promise — keep your try/catch for those, but
// `WorkflowStreamOptions.onError` is NOT invoked for suspension.
```

> **Stream-mode dead-air warning:** the stream stays open while `.finally()` bodies run after a gate suspends. Long-running cleanup work causes proportional dead air. If your HTTP read timeout is shorter than your worst-case finally I/O, the connection can disconnect spuriously.

### Schema validation

Add a `schema` to validate the human response at runtime. The schema uses a structural type — any object with a `.parse()` method works (Zod, Valibot, ArkType, etc.):

```ts
const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    schema: z.object({ approved: z.boolean(), notes: z.string() }),
  })
  .step("publish", ({ input }) => {
    if (!input.approved) return "Rejected";
    return `Published with notes: ${input.notes}`;
  });

// Resume — gate ID enables type inference, schema validates at runtime
const resumed = pipeline.loadState("review", snapshot);
await resumed.generate(ctx, { approved: true, notes: "lgtm" }); // passes
await resumed.generate(ctx, { approved: "yes" });                // throws parse error
```

### Multiple gates

A workflow can have multiple gates. Each `generate()`/`stream()` call advances to the next gate or completes:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review")
  .step("process", ({ input }) => `reviewed: ${input}`)
  .gate("final-approval")
  .step("publish", ({ input }) => `published: ${input}`);

// First gate
const r1 = await pipeline.generate(ctx, input);
if (r1.status !== "suspended") throw new Error("expected suspension at review");
let snapshot = r1.snapshot;

// Second gate
const resumed1 = pipeline.loadState("review", snapshot);
const r2 = await resumed1.generate(ctx, "first approval");
if (r2.status !== "suspended") throw new Error("expected suspension at final-approval");
snapshot = r2.snapshot;

// Complete
const resumed2 = pipeline.loadState("final-approval", snapshot);
const r3 = await resumed2.generate(ctx, "final approval");
if (r3.status === "complete") console.log(r3.output);
```

### Manual merge at the call site

The `snapshot.output` field contains the pre-gate output. Merge it with the human response at the call site:

```ts
// The step after the gate needs both the draft and the approval
const resumed = pipeline.loadState("review", snapshot);
await resumed.generate(ctx, {
  draft: snapshot.output,       // pre-gate output
  approval: humanResponse,      // human's response
});
```

For automatic merging without exposing `snapshot.output` to the caller, see the `merge` option below.

### Injecting updated context on resume

`ctx` is provided fresh on every `generate()`/`stream()` call — never serialized. Use it to inject updated chat history, refreshed auth tokens, or new database connections:

```ts
const freshCtx = {
  chatHistory: await db.loadChatHistory(userId), // includes messages added during the pause
  db: getDbConnection(),
  userId,
};
const resumed = pipeline.loadState("review", snapshot);
await resumed.stream(freshCtx, humanResponse);
```

### Conditional gates

Use `condition` to make a gate fire only when a predicate returns `true`. When the condition returns `false`, the gate is skipped and the current output passes through unchanged:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    condition: ({ input }) => input.needsReview,
  })
  .step(publishAgent);
```

### Merging pre-gate output with response via `merge`

Use `merge` to combine the pre-gate output with the human response into a single value for the next step. Without `merge`, only the human response is forwarded.

`merge` may return any shape — its return type becomes the input type of the next step. The gate's third generic `TMerged` is inferred from the merge return type, so downstream steps type-check against the merged shape:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    schema: approvalSchema,
    merge: ({ priorOutput, response }) => ({
      draft: priorOutput,        // pre-gate output (TOutput)
      approval: response,        // validated human response (TResponse)
    }),
  })
  .step("publish", ({ input }) => {
    // input is { draft, approval } — the TMerged shape
  });
```

### Snapshot shape

As of 0.5.0, `WorkflowSnapshot` is a discriminated union with three variants — gate snapshots emitted by `.gate()`, checkpoint snapshots emitted by `onCheckpoint`, and the legacy v1 form from 0.4.0 (accepted for one release via the shim):

```ts
interface GateSnapshot {
  version: 2;
  kind: "gate";
  resumeFromIndex: number;  // step index of the gate
  output: unknown;          // pre-gate output
  gateId: string;           // gate identifier
  gatePayload: unknown;     // data for the human
}

interface CheckpointSnapshot {
  version: 2;
  kind: "checkpoint";
  resumeFromIndex: number;  // index of the NEXT step to run
  output: unknown;          // output as of the checkpoint
  stepShapeHash: string;    // SHA-256 hex of the workflow's structural shape
}

// Legacy v1 — only accepted by loadState() during one release. Migrate via migrateSnapshot().
interface LegacyGateSnapshotV1 {
  version: 1;
  kind?: undefined;
  resumeFromIndex: number;
  output: unknown;
  gateId: string;
  gatePayload: unknown;
}

type WorkflowSnapshot = GateSnapshot | CheckpointSnapshot | LegacyGateSnapshotV1;
```

`WorkflowResult<T>` narrows the suspended-branch `snapshot` to `GateSnapshot` specifically — only gates suspend, so the union widening doesn't pollute the suspended-state API.

> **Rolling-deploy hazard:** A 0.4.0 process receiving a 0.5.0-persisted v2 gate snapshot rejects via the strict `version === 1` check. Drain in-flight snapshots before cutover, ship a 0.4.x forward-compat patch ahead, or version-tag storage keys.

> **Long-lived storage:** For Redis-without-TTL / S3 / Postgres, call `migrateSnapshot(legacy)` before v0.8.0+ drops v1 acceptance.

## Step-level checkpointing via `onCheckpoint`

Pass `onCheckpoint` in `RunOptions` to receive a v2 checkpoint snapshot after each successful step body. Use this to persist progress so a crashed/restarted process can resume where it left off — no human-in-the-loop required.

```ts
import { Workflow, type CheckpointSnapshot } from "pipeai";

const pipeline = Workflow.create<Ctx, string>()
  .step("classify", classifier)
  .step("summarize", summarizer)
  .step("publish", publisher);

let lastSnapshot: CheckpointSnapshot | null = null;
const result = await pipeline.generate(ctx, "input", {
  onCheckpoint: async (snap) => {
    lastSnapshot = snap;
    await db.write({ key: "run:42", snapshot: snap });
  },
  checkpointEvery: 5,    // every 5 executable steps
});

// On restart, resume from the last persisted snapshot:
const stored = await db.read("run:42");
const resumed = pipeline.resumeFrom(stored);
const final = await resumed.generate(ctx);   // no response arg — state is seeded
```

### Cadence

- `checkpointEvery: N` — fire every N executable steps. Defaults to `max(1, ceil(executableCount / 4))` — 4 checkpoints across the run, floor of every step on tiny pipelines.
- `checkpointWhen({ stepIndex, stepId, ctx }) => boolean` — predicate variant. Mutually exclusive with `checkpointEvery`.
- `.catch()` and `.finally()` nodes are NOT counted as executable, so adding cleanup doesn't surprise you with extra checkpoints.

### Timeout via `AbortSignal`

```ts
const result = await pipeline.generate(ctx, input, {
  onCheckpoint: async (snap, { signal }) => {
    await fetch("/persist", { method: "POST", body: JSON.stringify(snap), signal });
  },
  checkpointTimeout: 500,   // ms — AbortSignal fires, CheckpointTimeoutError raised
});
```

A timed-out `onCheckpoint` raises `CheckpointTimeoutError`, which (like any `onCheckpoint` throw) bypasses `.catch()` and reaches the caller bare. `.finally()` still runs; any finally errors get a `console.warn`.

### `stepShapeHash` and `resumeFrom`

Each checkpoint snapshot carries a SHA-256 of the workflow's structural shape (index + type + id + recursive nested workflow shapes). `resumeFrom` verifies the hash matches before continuing:

```ts
const resumed = pipeline.resumeFrom(snapshot);                       // throws on shape mismatch
const resumed = pipeline.resumeFrom(snapshot, { skipShapeCheck: true });  // override
```

Common shape changes that invalidate snapshots: insertion, removal, reorder, type-swap with same id, nested-workflow refactor. **Agent identity is NOT in the hash** — two checkpoints from runs that used different agent configs (same agent id) hash identically. Version your agents by content if resume-trust matters.

### Stream-mode caveats

- Each `onCheckpoint` fire pauses the stream writer while it awaits — for chunky checkpoints, prefer larger cadence.
- Per-checkpoint `JSON.stringify` cost grows with `state.output`; the example above uses `checkpointEvery: 5` to amortize.
- Serializing consumers should leave `freezeSnapshots: false` — `JSON.stringify` already copies.

### Memoization

`stepShapeHash` is memoized per terminal-workflow instance. **Build pipelines once at module load and call `generate()` many times** to amortize. Per-request construction defeats memoization.

### `.catch()` placed before `resumeFromIndex` is dead

After a checkpoint-resume, any `.catch()` nodes BEFORE the resume index never fire (they're skipped along with all earlier steps). Place catches at the end of the workflow or strategically late.

### Gate-vs-checkpoint resume asymmetry

Gate snapshots use a reorder-tolerant id-scan fallback in `loadState`. Checkpoint snapshots use `stepShapeHash`, which is reorder-strict. A workflow with both has two different resume semantics — when in doubt, bump a workflow version id and route old snapshots to old code.

### Catastrophic combos

`validateRunOptions` throws synchronously on:
- `checkpointEvery` and `checkpointWhen` both set (mutually exclusive)
- `checkpointEvery` not a positive integer
- `checkpointTimeout` not a finite positive number
- `freezeSnapshots: true + checkpointEvery: 1` on a workflow of 8+ steps (catastrophic perf — pass `"iAcceptThePerformanceCost"` to bypass)

And warns once on `freezeSnapshots: true + cadence <= 2` (suspicious but legal).

### Limitations

Gates inside nested workflows, `foreach()`, and `repeat()` are not yet supported — `NestedGateUnsupportedError` is thrown at runtime. Gates at the top level of a workflow work in all cases.

```ts
import { NestedGateUnsupportedError } from "pipeai";

try {
  await pipeline.generate(ctx, input);
} catch (e) {
  if (e instanceof NestedGateUnsupportedError) {
    console.log(`gate "${e.gateId}" in nested workflow "${e.workflowId}"`);
    // e.siblingErrors — non-gate rejections from concurrent foreach siblings
    // e.siblingSuspensions — other items in concurrent foreach that also suspended
  }
}
```

> **Middleware-wrapping caveat:** `NestedGateUnsupportedError` `instanceof` is only stable when caught close to the call site. App-specific error wrappers that re-throw as their own types defeat the check. Preserve `cause` if you wrap.

> **Foreach concurrency hazard:** a nested gate inside concurrent `foreach` waits for siblings to complete — sibling LLM calls bill, sibling DB writes commit. Either use `concurrency: 1` or move the gate above the `foreach`. Sibling-side non-gate errors are preserved in `result.warnings` (`source: "foreach-sibling"`) and attached to the marker via `siblingErrors`. The lowest-index suspending item wins the marker; the rest contribute to `siblingSuspensions`.

### Snapshot immutability (opt-in)

By default snapshots and `result.warnings` are mutable. Pass `freezeSnapshots: true` in `RunOptions` to recursively `Object.freeze` them — useful when you serialize through an in-memory queue and want to catch accidental mutation:

```ts
const result = await pipeline.generate(ctx, input, { freezeSnapshots: true });
```

The same flag governs gate snapshots, F1's checkpoint snapshots (when shipped), and the warnings array. **For serializing consumers, leave it `false`** — `JSON.stringify` already copies, and freezing every step is wasted work. `runOptions` does **not** propagate into nested workflows.

Caveat: `Object.freeze(new Map())` doesn't prevent `.set()`. Maps and Sets inside payloads lose immutability.

## Observability via `Workflow.create({ observability })`

Pass an `observability` object to `Workflow.create()` to receive lifecycle events for every node in the workflow:

```ts
import { Workflow, type WorkflowObservability } from "pipeai";

// `WorkflowObservability<Ctx>` types `ctx` in every hook as your context.
// It defaults to `unknown`, so the bare `WorkflowObservability` form still
// works for context-agnostic hooks.
const obs: WorkflowObservability<Ctx> = {
  onStepStart: ({ stepId, type, ctx, input }) => {
    console.log(`[${ctx.requestId}] step ${stepId} (${type}) starting`);
  },
  onStepFinish: ({ stepId, type, output, durationMs, suspended }) => {
    console.log(`step ${stepId} (${type}) finished in ${durationMs}ms, suspended=${suspended}`);
  },
  onStepError: ({ stepId, type, error, durationMs }) => {
    console.error(`step ${stepId} (${type}) threw after ${durationMs}ms`, error);
  },
};

const pipeline = Workflow.create<Ctx, string>({ observability: obs })
  .step("classify", classifier)
  .step("respond", responder);
```

`ctx` is typed as the workflow's context: pass `WorkflowObservability<Ctx>` (or just inline the object into `Workflow.create<Ctx>({ observability: { ... } })` and let `Ctx` flow in). The `input` / `output` fields stay `unknown` — they differ at every step in the chain, so only `ctx` (constant across the run) can be typed.

The hooks are threaded through every builder return, so any chain following `Workflow.create({ observability })` keeps the same hooks. `ResumedWorkflow` (gate resume via `loadState`) and `CheckpointResumedWorkflow` (checkpoint resume via `resumeFrom`) ALSO inherit it — events fire on resumed runs without re-wiring.

### Per-node firing rules

| Node | `onStepStart` | `onStepFinish` (`suspended`) | `onStepError` |
|---|---|---|---|
| step / nested / branch / foreach / parallel / repeat | always | when body returns (`false`) | on body throw |
| gate (suspends) | always | `suspended: true` | never |
| gate (cond false → skip) | always | `suspended: false` | never |
| catch | only when `pendingError` set | when `catchFn` returns | when `catchFn` throws |
| finally | always (runs even after suspension) | always (`suspended: false`) | when body throws |

Skip-checked nodes (suspension or error state already set on entry) emit **nothing** — `.finally()` is the exception.

### Per-item events for `foreach` and `parallel`

`foreach` and `parallel` ALSO fire per-item events:

```ts
const obs: WorkflowObservability = {
  onItemStart: ({ stepId, type, itemIndex, input }) => { /* ... */ },
  onItemFinish: ({ stepId, type, itemIndex, output, durationMs }) => { /* ... */ },
  onItemError: ({ stepId, type, itemIndex, error, durationMs }) => { /* ... */ },
};
```

- For `foreach`: `itemIndex` is the item's numeric index.
- For `parallel` record form: `itemIndex` is the branch's string key.
- For `parallel` tuple form: `itemIndex` is the branch's numeric index.
- `repeat` does **NOT** emit per-item events. Its iteration count is data-dependent — per-item would mislead.

### Error semantics inside hooks

- Errors thrown inside `onStepStart`, `onStepFinish`, `onItemStart`, `onItemFinish`, `onItemError` are captured into `result.warnings` with the matching `source` tag and mirrored to `console.error`. The workflow continues.
- Errors thrown inside `onStepError` on the normal path cause the ORIGINAL step error to reach the caller with `error.cause = obsError`. The `instanceof` of the original error is preserved.
- `onCheckpoint` failures fire `onStepError({ stepId: CHECKPOINT_STEP_ID, type: "step", ... })`.

### Concurrent-run-safe OTel pattern

Don't key observability state on `ctx` alone — concurrent runs share it. Use a per-`runId` key:

```ts
type Ctx = { userId: string; runId: string };
const spans = new Map<string, ReturnType<typeof tracer.startSpan>>();

const pipeline = Workflow.create<Ctx>({
  observability: {
    onStepStart: ({ stepId, type, ctx }) => {
      const c = ctx as Ctx;
      spans.set(`${c.runId}:${stepId}`, tracer.startSpan(`${type}:${stepId}`, {
        attributes: { userId: c.userId },
      }));
    },
    onStepFinish: ({ stepId, ctx, durationMs, suspended }) => {
      const c = ctx as Ctx; const key = `${c.runId}:${stepId}`;
      const span = spans.get(key);
      span?.setAttribute("duration_ms", durationMs);
      span?.setAttribute("suspended", suspended);
      span?.end(); spans.delete(key);
    },
    onStepError: ({ stepId, ctx, error }) => {
      const c = ctx as Ctx; const key = `${c.runId}:${stepId}`;
      const span = spans.get(key);
      span?.recordException(error as Error);
      span?.setStatus({ code: SpanStatusCode.ERROR });
      span?.end(); spans.delete(key);
    },
  },
}).step(classifier).step(supportAgent);
```

## Graph patterns

The existing combinators compose into common workflow graph shapes — no new primitives needed.

### Cycles via `repeat(subWorkflow, { until })`

Re-run a sub-workflow until a predicate is satisfied:

```ts
const cycle = Workflow.create<Ctx, Plan>().step(executor).step(critic);

const agent = Workflow.create<Ctx, string>()
  .step(planner)
  .repeat(cycle, { until: ({ output }) => output.satisfied, maxIterations: 5 });
```

`repeat` runs its body as a sub-workflow; the body's output feeds back as input.

### Multi-path branching with rejoin via `.branch(...).step(...)`

The first step AFTER a `branch` is the rejoin point — the chosen branch's output flows in regardless of which case fired:

```ts
const pipeline = Workflow.create<Ctx>()
  .step("classify", classifier)
  .branch({
    select: ({ input }) => input as "bug" | "feature",
    agents: { bug: bugAgent, feature: featureAgent },
  })
  .step("persist", ({ input, ctx }) => db.save(ctx.userId, input));
```

### Fan-out / fan-in via `.parallel({...}).step(...)`

`parallel` produces a record/tuple; the next step consumes the combined shape:

```ts
const pipeline = Workflow.create<Ctx, string>()
  .step("init", ({ input }) => input)
  .parallel({ researcher, critic })
  .step("synthesize", ({ input }) => `${input.researcher} + ${input.critic}`);
```

Pair with the [rate-limit and ctx-mutation hazards](#fan-out-via-parallel) above.

### Self-recursion is NOT supported

```ts
// Doesn't work — `recur` is undefined at evaluation.
let recur;
recur = Workflow.create<Ctx, string>()
  .step(executor)
  .repeat(recur, { until: () => false });   // ← recur is undefined here
```

A future `repeat(thunk)` overload (F4.5 candidate) could enable this — the cycle guard inside `stepShapeHash` is already prepared for it.

## Migration from 0.3.x

0.4.0 makes suspension a return value instead of a thrown error, plus seven smaller behavior changes. The full list:

1. **`.finally()` runs after a gate suspends.** Code that assumed `finally` ran only on completion must now check `result.status === "complete"`.
2. **Nested-workflow `.finally()` bodies run before `NestedGateUnsupportedError` fires.** Inner finallys see `state.suspension` truthy while running — don't branch on it. Side-effecting inner finallys execute on a path the user perceives as a thrown error.
3. **A throwing `.finally()` no longer aborts subsequent `.finally()` bodies.** All finallys run; their errors accumulate.
4. **`WorkflowSuspended` is deleted.** Migrate `try / catch (e instanceof WorkflowSuspended)` → `if (result.status === "suspended")`.
5. **`WorkflowResult<T>` shape changed.** `const { output } = await pipeline.generate(...)` is now a strict-mode compile error. Use `if (result.status !== "complete") throw …; const { output } = result`.
6. **`stream()` on suspension closes cleanly.** `WorkflowStreamOptions.onError` is **not** invoked for suspension — discriminate via the resolved `output` Promise. Real errors still flow through `onError`. F0 emits a one-time `console.warn` per process when a gate fires in stream mode with `onError` set.
7. **Any** `.finally()` body that throws on the completion path produces `AggregateError` — stable contract once any finally is added, including the single-error case.
8. **Duplicate `(type, id)` pairs in the same workflow throw at builder finalization.** `foreach(agentX).foreach(agentX)` and back-to-back default-id `branch(...)` callers must pass an explicit `{ id }`. The same applies to `step(agent, { id })` when reusing an agent in two steps.

Before:

```ts
import { WorkflowSuspended } from "pipeai";
try {
  const { output } = await pipeline.generate(ctx, input);
  return output;
} catch (e) {
  if (e instanceof WorkflowSuspended) {
    await db.saveSnapshot(e.snapshot);
    return null;
  }
  throw e;
}
```

After:

```ts
const result = await pipeline.generate(ctx, input);
if (result.status === "suspended") {
  await db.saveSnapshot(result.snapshot);
  return null;
}
return result.output;
```

## Full Example

```ts
import { Agent, Workflow, defineTool } from "pipeai";
import { Output } from "ai";
import { openai } from "@ai-sdk/openai";
import { z } from "zod";

type Ctx = {
  chatHistory: ModelMessage[];
  db: Database;
  userId: string;
};

// 1. Define context-aware tools
const define = defineTool<Ctx>();

const searchLogs = define({
  description: "Search application logs",
  input: z.object({ query: z.string() }),
  execute: async ({ query }, ctx) => ctx.db.logs.search(query),
});

const createTicket = define({
  description: "Create a support ticket",
  input: z.object({ title: z.string(), body: z.string() }),
  execute: async ({ title, body }, ctx) => ctx.db.tickets.create(ctx.userId, title, body),
});

// 2. Define classifier
const classifier = new Agent<Ctx>({
  id: "classifier",
  output: Output.object({
    schema: z.object({
      agent: z.enum(["bug", "feature", "question"]),
      reasoning: z.string(),
    }),
  }),
  model: openai("gpt-4o-mini"),
  system: "Classify the user's request. Pick the best agent.",
  messages: (ctx) => ctx.chatHistory,
});

// 3. Define specialist agents
const bugAgent = new Agent<Ctx>({
  id: "bug",
  model: openai("gpt-4o"),
  system: "You help users debug issues.",
  messages: (ctx) => ctx.chatHistory,
  tools: { searchLogs, createTicket },
});

const featureAgent = new Agent<Ctx>({
  id: "feature",
  model: openai("gpt-4o"),
  system: "You help with feature requests.",
  messages: (ctx) => ctx.chatHistory,
});

const questionAgent = new Agent<Ctx>({
  id: "question",
  model: openai("gpt-4o"),
  system: "You answer general questions.",
  messages: (ctx) => ctx.chatHistory,
});

// 4. Compose workflow
const pipeline = Workflow.create<Ctx>()
  // Classify silently — consume the stream without forwarding to client
  .step(classifier, {
    handleStream: async ({ result }) => { await result.text; },
  })
  // Route to the right specialist based on classification
  .branch({
    select: ({ input }) => input.agent,
    agents: { bug: bugAgent, feature: featureAgent, question: questionAgent },
    // Persist the agent's full result for conversation history
    onGenerateResult: async ({ result, ctx }) => {
      await ctx.db.conversations.append(ctx.userId, {
        role: "assistant",
        content: result.text,
        toolCalls: result.toolCalls,
      });
    },
    onStreamResult: async ({ result, ctx }) => {
      await ctx.db.conversations.append(ctx.userId, {
        role: "assistant",
        content: await result.text,
      });
    },
  })
  .catch("fallback", ({ error, ctx, stepId }) => {
    console.error(`Step "${stepId}" failed`, error);
    return "Sorry, something went wrong. Please try again.";
  })
  .finally("cleanup", ({ ctx }) => {
    ctx.db.audit.log(ctx.userId, "pipeline-complete");
  });

// 5. Execute with streaming
const ctx = { chatHistory: messages, db: myDb, userId: "user-123" };

const { stream, output } = pipeline.stream(ctx, undefined, {
  onError: (error) => {
    console.error("Stream error", error);
    return "Something went wrong.";
  },
});
return new Response(stream);
```

## License

MIT
