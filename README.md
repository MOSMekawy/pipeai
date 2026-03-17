# agent-workflow

A typed multi-agent workflow pipeline built on top of the [Vercel AI SDK v6](https://sdk.vercel.ai/). It provides two core primitives — **Agent** and **Workflow** — that compose into declarative, streamable AI pipelines with shared context and typed outputs.

Agents are pure AI SDK wrappers that return native `GenerateTextResult` / `StreamTextResult`. Workflows chain agents into pipelines with automatic stream merging, deterministic agent routing, and typed output extraction.

The library is ~800 lines across 4 files. It's designed to be read, understood, and modified — a thin composition layer over AI SDK, not a framework to learn around.

## Core Concepts

| Primitive      | Purpose                                                                                              |
| -------------- | ---------------------------------------------------------------------------------------------------- |
| `Agent`        | A pure AI SDK wrapper. Supports `generate()`, `stream()`, and `asTool()` for agent-as-tool composition. |
| `Workflow`     | A typed pipeline that chains agents with `step()`, `branch()`, `catch()`, and `finally()`.            |
| `defineTool`   | A context-aware tool factory — injects runtime context into tool `execute` calls.                     |

## Installation

```bash
npm install agent-workflow
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
import { Agent } from "agent-workflow";
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

Same callback names as AI SDK v6, extended with `ctx` and `input`. The AI SDK event payload is available as `result`:

```ts
const agent = new Agent<Ctx>({
  id: "monitored",
  model: openai("gpt-4o"),
  prompt: (ctx, input) => input,
  onStepFinish: ({ result, ctx }) => {
    console.log(`Step done, used ${result.usage.totalTokens} tokens`);
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
| `toolChoice`  | `ToolChoice`              | Tool choice strategy.                                             |
| `stopWhen`    | `StopCondition`           | Condition for stopping the tool loop.                             |
| `prepareStep` | `PrepareStepFunction`     | Prepare each step before execution.                               |
| `onStepFinish`| `({ result, ctx, input })`| Called after each step.                                           |
| `onFinish`    | `({ result, ctx, input })`| Called when all steps complete.                                   |
| `onError`     | `({ error, ctx, input })` | Called on error.                                                  |

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

**Note:** `asTool()` uses `generate()` internally — sub-agent execution is non-streaming. This is an AI SDK tool loop constraint. For streaming multi-agent workflows, use `step()` with `branch()` instead.

## defineTool — Context-Aware Tools

`defineTool` wraps a tool definition so the agent's runtime context is injected into every `execute` call. The `input` field maps to AI SDK's `parameters`:

```ts
import { defineTool } from "agent-workflow";
import { tool } from "ai";

type Ctx = { db: Database; userId: string };

const define = defineTool<Ctx>();

const searchOrders = define({
  description: "Search user orders",
  input: z.object({ query: z.string() }),
  execute: async ({ query }, ctx) => {
    return ctx.db.orders.search(ctx.userId, query);
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

## Workflow

A `Workflow` chains agents and transformation steps into a typed pipeline. Context is read-only — agents communicate through outputs.

### Building a workflow

```ts
import { Workflow } from "agent-workflow";

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
      files: [],
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
    onStreamResult: async ({ result, ctx, input }) => {
      await ctx.db.conversations.save(ctx.userId, {
        role: "assistant",
        content: await result.text,
      });
    },
  });
```

### Fine-grained stream control

Override how each agent's stream is merged into the workflow stream. By default, every agent's output is merged into the workflow stream via `writer.merge(result.toUIMessageStream())`. Use `handleStream` to change this — for example, to suppress intermediate agents so only the final response streams to the client:

```ts
const pipeline = Workflow.create<Ctx>()
  // Suppress the classifier's stream — the user shouldn't see
  // the structured classification output, only the final response
  .step(classifier, {
    handleStream: async ({ result }) => {
      await result.text; // consume the stream without forwarding it
    },
  })
  .branch({
    select: ({ input }) => input.agent,
    agents: { bug: bugAgent, feature: featureAgent, question: questionAgent },
  });
  // Only the selected agent's response streams to the client
```

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
| `.step(id, fn)`           | Transform the output. `fn` receives `{ ctx, input }` and returns the new output. |
| `.branch([...cases])`     | Predicate routing. First `when` match wins; case without `when` is default. |
| `.branch({ select, agents })` | Key routing. `select` returns a key, runs the matching agent.          |
| `.catch(id, fn)`          | Handle errors. `fn` receives `{ error, ctx, stepId }` and returns a recovery value. |
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

## Full Example

```ts
import { Agent, Workflow, defineTool } from "agent-workflow";
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
  // Classify silently — don't stream the structured JSON to the client
  .step(classifier, {
    handleStream: async ({ result }) => {
      await result.text;
    },
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
