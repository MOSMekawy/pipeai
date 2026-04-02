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

const assistant = new Agent<Ctx>({
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

const classifier = new Agent<Ctx>({
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
const agent = new Agent<Ctx>({
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
const agent = new Agent<Ctx>({
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
| `model`       | `Resolvable`              | Language model. Static or `(ctx, input) => model`.                |
| `system`      | `Resolvable`              | System prompt.                                                    |
| `prompt`      | `Resolvable`              | String prompt. Mutually exclusive with `messages`.                |
| `messages`    | `Resolvable`              | Message array. Mutually exclusive with `prompt`.                  |
| `tools`       | `Resolvable`              | Tool map. Supports `Tool`, `ToolProvider`, and `agent.asTool()`.  |
| `activeTools` | `Resolvable`              | Subset of tool names to enable.                                   |
| `toolChoice`  | `Resolvable`              | Tool choice strategy. Static or `(ctx, input) => toolChoice`.     |
| `stopWhen`    | `Resolvable`              | Condition for stopping the tool loop. Static or `(ctx, input) => condition`. |
| `onStepFinish`| `({ result, ctx, input, writer? })`| Called after each step. `writer` available in streaming workflows. |
| `onFinish`    | `({ result, ctx, input, writer? })`| Called when all steps complete.                                   |
| `onError`     | `({ error, ctx, input, writer? })` | Called on error.                                                  |
| `...`         | AI SDK options            | All other `streamText`/`generateText` options pass through (e.g. `temperature`, `maxTokens`, `maxRetries`, `headers`, `prepareStep`, `onChunk`, etc.). |

## `asTool()` — Agent as Tool

`asTool()` compiles an agent into a standard AI SDK `Tool`. The parent agent's LLM tool loop handles routing — no dedicated router needed.

```ts
const codingAgent = new Agent<Ctx>({
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

const qaAgent = new Agent<Ctx>({
  id: "qa",
  description: "Answers technical questions.",
  input: z.object({ question: z.string() }),
  model: openai("gpt-4o"),
  prompt: (ctx, input) => input.question,
  tools: { readFile, search },
});

// Parent agent uses sub-agents as tools
const orchestrator = new Agent<Ctx>({
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
const orchestrator = new Agent<Ctx>({
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

`defineTool` wraps a tool definition so the agent's runtime context is injected into every `execute` call. The `input` field maps to AI SDK's `parameters`. When running inside a streaming workflow, the `writer` is automatically available in the third parameter for streaming metadata or progress updates to the client:

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
const agent = new Agent<Ctx>({
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

### Running a workflow

```ts
// Non-streaming — calls agent.generate() at each step
const { output } = await pipeline.generate(ctx, initialInput);

// Streaming — calls agent.stream() at each step, merges into a single ReadableStream
const { stream, output } = pipeline.stream(ctx, initialInput);
return new Response(stream);

const finalOutput = await output;  // resolves when pipeline completes
```

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

Concurrent processing with batched parallelism:

```ts
// Process 3 items at a time
.foreach(summarizer, { concurrency: 3 })
```

Works with nested workflows too:

```ts
const processItem = Workflow.create<Ctx, string>()
  .step(analyzeAgent)
  .step(enrichAgent);

const pipeline = Workflow.create<Ctx>()
  .step("fetch-items", async ({ ctx }) => ctx.db.items.getAll())
  .foreach(processItem, { concurrency: 5 });
```

**Type safety:** `foreach()` uses `ElementOf<TOutput>` to extract the array element type. If the previous step doesn't produce an array, the call is rejected at compile time.

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
| `.foreach(target, opts?)` | Map each array element through an agent or workflow. `opts.concurrency` controls parallelism (default: 1). |
| `.repeat(target, opts)`   | Loop an agent or workflow. Use `{ until }` or `{ while }` (mutually exclusive). `maxIterations` defaults to 10. |
| `.gate(id, opts?)`        | Human-in-the-loop suspension point. Throws `WorkflowSuspended` with a serializable snapshot. Resume via `loadState(gateId, snapshot)`. |
| `.catch(id, fn)`          | Handle errors. `fn` receives `{ error, ctx, lastOutput, stepId }` and returns a recovery value. |
| `.finally(id, fn)`        | Always runs. `fn` receives `{ ctx }`.                                      |

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

### Basic gate

```ts
import { Workflow, WorkflowSuspended } from "pipeai";

const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    payload: ({ input }) => ({ draft: input, instructions: "Please review this draft" }),
  })
  .step(publishAgent);

// Run — suspends at gate
try {
  await pipeline.generate(ctx, input);
} catch (e) {
  if (e instanceof WorkflowSuspended) {
    await db.saveSnapshot(e.snapshot);
    return res.status(202).json(e.snapshot.gatePayload);
  }
}

// Resume — load state, pass gate ID + snapshot to generate or stream
const snapshot = await db.loadSnapshot(id);
const resumed = pipeline.loadState("review", snapshot);
const { output } = await resumed.generate(ctx, humanResponse);
```

The `snapshot` is plain JSON — it survives `JSON.parse(JSON.stringify())`, database storage, and process restarts. The workflow definition (code) stays in the process; only the data is serialized.

### Resuming with streaming

For chat applications where the client reconnects and needs a live stream for the remaining steps:

```ts
const resumed = pipeline.loadState("review", snapshot);
const { stream, output } = resumed.stream(ctx, humanResponse);
return new Response(stream);
```

The previous stream is gone — the library only streams forward from the resume point. Load prior chat history from your database and send it to the client before piping the resume stream.

### Streaming suspension

When `stream()` hits a gate, the stream closes cleanly (partial content from steps before the gate is delivered). The `output` promise rejects with `WorkflowSuspended`:

```ts
const { stream, output } = pipeline.stream(ctx, input);
pipeStreamToResponse(res, stream); // partial content delivered normally

try {
  await output;
} catch (e) {
  if (e instanceof WorkflowSuspended) {
    await db.saveSnapshot(e.snapshot);
  }
}
```

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
let snapshot: WorkflowSnapshot;
try { await pipeline.generate(ctx, input); }
catch (e) { snapshot = (e as WorkflowSuspended).snapshot; }

// Second gate
const resumed1 = pipeline.loadState("review", snapshot);
try { await resumed1.generate(ctx, "first approval"); }
catch (e) { snapshot = (e as WorkflowSuspended).snapshot; }

// Complete
const resumed2 = pipeline.loadState("final-approval", snapshot);
const { output } = await resumed2.generate(ctx, "final approval");
```

### Merging pre-gate output with response

The `snapshot.output` field contains the pre-gate output. Use it to merge with the human response:

```ts
// The step after the gate needs both the draft and the approval
const resumed = pipeline.loadState("review", snapshot);
await resumed.generate(ctx, {
  draft: snapshot.output,       // pre-gate output
  approval: humanResponse,      // human's response
});
```

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

### Merging pre-gate output with response

Use `merge` to combine the pre-gate output with the human response into a single value for the next step. Without `merge`, only the human response is forwarded:

```ts
const pipeline = Workflow.create<Ctx>()
  .step(draftAgent)
  .gate("review", {
    merge: ({ priorOutput, response }) => ({
      draft: priorOutput,
      approval: response,
    }),
  })
  .step("publish", ({ input }) => {
    // input is { draft, approval }
  });
```

### Snapshot shape

```ts
interface WorkflowSnapshot {
  version: 1;
  resumeFromIndex: number;  // step index of the gate
  output: unknown;          // pre-gate output
  gateId: string;           // gate identifier
  gatePayload: unknown;     // data for the human
}
```

### Limitations

Gates inside nested workflows, `foreach()`, and `repeat()` are not yet supported — a descriptive error is thrown at runtime. Gates at the top level of a workflow work in all cases.

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
