import {
  createUIMessageStream,
  type UIMessageStreamWriter,
} from "ai";
import { type Agent, type GenerateTextResult, type StreamTextResult } from "./agent";
import { extractOutput, type MaybePromise } from "./utils";

// ── Error Types ─────────────────────────────────────────────────────

export class WorkflowBranchError extends Error {
  constructor(
    public readonly branchType: "predicate" | "select",
    message: string,
  ) {
    super(message);
    this.name = "WorkflowBranchError";
  }
}

export class WorkflowLoopError extends Error {
  constructor(
    public readonly iterations: number,
    public readonly maxIterations: number,
  ) {
    super(`Loop exceeded maximum iterations (${maxIterations})`);
    this.name = "WorkflowLoopError";
  }
}

// ── Shared Agent Step Hooks ─────────────────────────────────────────

export interface AgentStepHooks<TContext, TOutput, TNextOutput> {
  mapGenerateResult?: (params: { result: GenerateTextResult; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  mapStreamResult?: (params: { result: StreamTextResult; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  onGenerateResult?: (params: { result: GenerateTextResult; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  onStreamResult?: (params: { result: StreamTextResult; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  handleStream?: (params: {
    result: StreamTextResult;
    writer: UIMessageStreamWriter;
    ctx: Readonly<TContext>;
  }) => MaybePromise<void>;
}

// ── Step Options ────────────────────────────────────────────────────

export type StepOptions<TContext, TOutput, TNextOutput> = AgentStepHooks<TContext, TOutput, TNextOutput>;

// ── Branch Types ────────────────────────────────────────────────────

export interface BranchCase<TContext, TOutput, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  when?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
  agent: Agent<TContext, TOutput, TNextOutput>;
}

export interface BranchSelect<TContext, TOutput, TKeys extends string, TNextOutput> extends AgentStepHooks<TContext, TOutput, TNextOutput> {
  select: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TKeys>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  agents: Record<TKeys, Agent<TContext, any, TNextOutput>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fallback?: Agent<TContext, any, TNextOutput>;
}

// ── Result Types ────────────────────────────────────────────────────

export interface WorkflowResult<TOutput> {
  output: TOutput;
}

export interface WorkflowStreamResult<TOutput> {
  stream: ReadableStream;
  output: Promise<TOutput>;
}

export interface WorkflowStreamOptions {
  onError?: (error: unknown) => string;
  onFinish?: () => MaybePromise<void>;
}

// ── Loop Types ──────────────────────────────────────────────────────

type LoopPredicate<TContext, TOutput> = (params: {
  output: TOutput;
  ctx: Readonly<TContext>;
  iterations: number;
}) => MaybePromise<boolean>;

// Exactly one of `until` or `while` — never both.
export type RepeatOptions<TContext, TOutput> =
  | { until: LoopPredicate<TContext, TOutput>; while?: never; maxIterations?: number }
  | { while: LoopPredicate<TContext, TOutput>; until?: never; maxIterations?: number };

// Extracts the element type from an array type. Resolves to `never` for non-arrays,
// making foreach uncallable at compile time when the previous step doesn't produce an array.
type ElementOf<T> = T extends readonly (infer E)[] ? E : never;

// ── Step Node ───────────────────────────────────────────────────────

type StepNode =
  | { readonly type: "step"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> }
  | { readonly type: "catch"; readonly id: string; readonly catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown> }
  | { readonly type: "finally"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> };

interface RuntimeState {
  ctx: unknown;
  output: unknown;
  mode: "generate" | "stream";
  writer?: UIMessageStreamWriter;
}

// ── Sealed Workflow (returned by finally — execution only) ───────────

export class SealedWorkflow<
  TContext,
  TInput = void,
  TOutput = void,
> {
  readonly id?: string;
  protected readonly steps: ReadonlyArray<StepNode>;

  protected constructor(steps: ReadonlyArray<StepNode>, id?: string) {
    this.steps = steps;
    this.id = id;
  }

  // ── Execution ─────────────────────────────────────────────────

  async generate(ctx: TContext, ...args: TInput extends void ? [input?: TInput] : [input: TInput]): Promise<WorkflowResult<TOutput>> {
    const input = args[0];
    const state: RuntimeState = {
      ctx,
      output: input,
      mode: "generate",
    };

    await this.execute(state);

    return {
      output: state.output as TOutput,
    };
  }

  stream(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: WorkflowStreamOptions]
      : [input: TInput, options?: WorkflowStreamOptions]
  ): WorkflowStreamResult<TOutput> {
    const input = args[0];
    const options = args[1] as WorkflowStreamOptions | undefined;

    let resolveOutput: (value: TOutput) => void;
    let rejectOutput: (error: unknown) => void;
    const outputPromise = new Promise<TOutput>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });

    // Prevent unhandled rejection warning if the consumer never awaits `output`.
    // The original promise still rejects normally when awaited.
    outputPromise.catch(() => {});

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        const state: RuntimeState = {
          ctx,
          output: input,
          mode: "stream",
          writer,
        };

        try {
          await this.execute(state);
          resolveOutput(state.output as TOutput);
        } catch (error) {
          rejectOutput!(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: options.onError } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
    });

    return {
      stream,
      output: outputPromise,
    };
  }

  // ── Internal: execute pipeline ────────────────────────────────

  protected async execute(state: RuntimeState): Promise<void> {
    if (this.steps.length === 0) {
      throw new Error("Workflow has no steps. Add at least one step before calling generate() or stream().");
    }

    let pendingError: { error: unknown; stepId: string } | null = null;

    for (const node of this.steps) {
      if (node.type === "finally") {
        await node.execute(state);
        continue;
      }

      if (node.type === "catch") {
        if (!pendingError) continue;
        try {
          state.output = await node.catchFn({
            error: pendingError.error,
            ctx: state.ctx,
            lastOutput: state.output,
            stepId: pendingError.stepId,
          });
          pendingError = null;
        } catch (catchError) {
          pendingError = { error: catchError, stepId: node.id };
        }
        continue;
      }

      // type === "step" — skip while in error state
      if (pendingError) continue;

      try {
        await node.execute(state);
      } catch (error) {
        pendingError = { error, stepId: node.id };
      }
    }

    if (pendingError) throw pendingError.error;
  }

  // ── Internal: execute a nested workflow within a step/loop ─────
  // Defined on SealedWorkflow (not Workflow) because TypeScript's protected
  // access rules only allow calling workflow.execute() from the same class.

  protected async executeNestedWorkflow(
    state: RuntimeState,
    workflow: SealedWorkflow<TContext, unknown, unknown>,
  ): Promise<void> {
    await workflow.execute(state);
  }

  // ── Internal: execute an agent within a step/branch ───────────
  // In stream mode, output extraction awaits the full stream before returning.
  // Streaming benefits the client (incremental output), not pipeline throughput —
  // each step still runs sequentially.

  protected async executeAgent<TAgentInput, TNextOutput>(
    state: RuntimeState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent: Agent<TContext, any, TNextOutput>,
    ctx: TContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    options?: AgentStepHooks<TContext, any, TNextOutput>,
  ): Promise<void> {
    const input = state.output as TAgentInput;
    const hasStructuredOutput = agent.hasOutput;

    if (state.mode === "stream" && state.writer) {
      const result = await (agent.stream as (ctx: TContext, input: unknown) => Promise<StreamTextResult>)(ctx, state.output);

      if (options?.handleStream) {
        await options.handleStream({ result, writer: state.writer, ctx });
      } else {
        state.writer.merge(result.toUIMessageStream());
      }

      if (options?.onStreamResult) {
        await options.onStreamResult({ result, ctx, input });
      }

      if (options?.mapStreamResult) {
        state.output = await options.mapStreamResult({ result, ctx, input });
      } else {
        state.output = await extractOutput(result, hasStructuredOutput);
      }
    } else {
      const result = await (agent.generate as (ctx: TContext, input: unknown) => Promise<GenerateTextResult>)(ctx, state.output);

      if (options?.onGenerateResult) {
        await options.onGenerateResult({ result, ctx, input });
      }

      if (options?.mapGenerateResult) {
        state.output = await options.mapGenerateResult({ result, ctx, input });
      } else {
        state.output = await extractOutput(result, hasStructuredOutput);
      }
    }
  }
}

// ── Workflow ────────────────────────────────────────────────────────

export class Workflow<
  TContext,
  TInput = void,
  TOutput = void,
> extends SealedWorkflow<TContext, TInput, TOutput> {

  private constructor(steps: ReadonlyArray<StepNode> = [], id?: string) {
    super(steps, id);
  }

  static create<TContext, TInput = void>(options?: { id?: string }): Workflow<TContext, TInput, TInput> {
    return new Workflow<TContext, TInput, TInput>([], options?.id);
  }

  static from<TContext, TInput, TOutput>(
    agent: Agent<TContext, TInput, TOutput>,
    options?: StepOptions<TContext, TInput, TOutput>
  ): Workflow<TContext, TInput, TOutput> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, any>([]).step(agent, options);
  }

  // ── step: agent overload ──────────────────────────────────────

  step<TNextOutput>(
    agent: Agent<TContext, TOutput, TNextOutput>,
    options?: StepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput>;

  // ── step: nested workflow overload ─────────────────────────────

  step<TNextOutput>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput>;

  // ── step: transform overload (replaces map + tap) ─────────────

  step<TNextOutput>(
    id: string,
    fn: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput>;

  // ── step: implementation ──────────────────────────────────────

  step<TNextOutput>(
    target: Agent<TContext, TOutput, TNextOutput> | SealedWorkflow<TContext, TOutput, TNextOutput> | string,
    optionsOrFn?: StepOptions<TContext, TOutput, TNextOutput> | ((params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>)
  ): Workflow<TContext, TInput, TNextOutput> {
    // Nested workflow overload: step(workflow)
    if (target instanceof SealedWorkflow) {
      const workflow = target;
      const node: StepNode = {
        type: "step",
        id: workflow.id ?? "nested-workflow",
        execute: async (state) => {
          await this.executeNestedWorkflow(state, workflow as SealedWorkflow<TContext, unknown, unknown>);
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Workflow<TContext, TInput, TNextOutput>([...this.steps, node] as any, this.id);
    }

    // Transform overload: step(id, fn)
    if (typeof target === "string") {
      if (typeof optionsOrFn !== "function") {
        throw new Error(`Workflow step("${target}"): second argument must be a function`);
      }
      const fn = optionsOrFn as (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
      const node: StepNode = {
        type: "step",
        id: target,
        execute: async (state) => {
          state.output = await fn({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          });
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return new Workflow<TContext, TInput, TNextOutput>([...this.steps, node] as any, this.id);
    }

    // Agent overload: step(agent, options?)
    const agent = target;
    const options = optionsOrFn as StepOptions<TContext, TOutput, TNextOutput> | undefined;
    const node: StepNode = {
      type: "step",
      id: agent.id,
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        await this.executeAgent(state, agent, ctx, options);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput>([...this.steps, node] as any, this.id);
  }

  // ── branch: predicate routing (array) ─────────────────────────

  branch<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[]
  ): Workflow<TContext, TInput, TNextOutput>;

  // ── branch: key routing (select) ──────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput>;

  // ── branch: implementation ────────────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    casesOrConfig: BranchCase<TContext, TOutput, TNextOutput>[] | BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput> {
    if (Array.isArray(casesOrConfig)) {
      return this.branchPredicate(casesOrConfig);
    }
    return this.branchSelect(casesOrConfig);
  }

  private branchPredicate<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[]
  ): Workflow<TContext, TInput, TNextOutput> {
    const node: StepNode = {
      type: "step",
      id: "branch:predicate",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;

        for (const branchCase of cases) {
          if (branchCase.when) {
            const match = await branchCase.when({ ctx, input });
            if (!match) continue;
          }

          // Matched (or no `when` = default)
          await this.executeAgent(state, branchCase.agent, ctx, branchCase);
          return;
        }

        throw new WorkflowBranchError("predicate", `No branch matched and no default branch (a case without \`when\`) was provided. Input: ${JSON.stringify(input)}`);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput>([...this.steps, node] as any, this.id);
  }

  private branchSelect<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput> {
    const node: StepNode = {
      type: "step",
      id: "branch:select",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;
        const key = await config.select({ ctx, input });

        let agent = config.agents[key];
        if (!agent) {
          if (config.fallback) {
            agent = config.fallback;
          } else {
            throw new WorkflowBranchError("select", `No agent found for key "${key}" and no fallback provided. Available keys: ${Object.keys(config.agents).join(", ")}`);
          }
        }

        await this.executeAgent(state, agent, ctx, config);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput>([...this.steps, node] as any, this.id);
  }

  // ── foreach: array iteration ─────────────────────────────────

  foreach<TNextOutput>(
    target: Agent<TContext, ElementOf<TOutput>, TNextOutput> | SealedWorkflow<TContext, ElementOf<TOutput>, TNextOutput>,
    options?: { concurrency?: number },
  ): Workflow<TContext, TInput, TNextOutput[]> {
    const concurrency = options?.concurrency ?? 1;
    const isWorkflow = target instanceof SealedWorkflow;
    const id = isWorkflow ? (target.id ?? "foreach") : `foreach:${(target as Agent<TContext, ElementOf<TOutput>, TNextOutput>).id}`;

    const node: StepNode = {
      type: "step",
      id,
      execute: async (state) => {
        const items = state.output;
        if (!Array.isArray(items)) {
          throw new Error(`foreach "${id}": expected array input, got ${typeof items}`);
        }

        const ctx = state.ctx as TContext;
        const results: unknown[] = new Array(items.length);

        // Streaming is intentionally not propagated to foreach items —
        // each item runs in generate mode because merging interleaved
        // streams from parallel items into a single writer is not supported.
        const executeItem = async (item: unknown, index: number) => {
          const itemState: RuntimeState = { ctx: state.ctx, output: item, mode: "generate" };
          if (isWorkflow) {
            await this.executeNestedWorkflow(itemState, target as SealedWorkflow<TContext, unknown, unknown>);
          } else {
            await this.executeAgent(itemState, target as Agent<TContext, unknown, TNextOutput>, ctx);
          }
          results[index] = itemState.output;
        };

        if (concurrency <= 1) {
          for (let i = 0; i < items.length; i++) {
            await executeItem(items[i], i);
          }
        } else {
          for (let i = 0; i < items.length; i += concurrency) {
            const batch = items.slice(i, i + concurrency);
            await Promise.all(batch.map((item, j) => executeItem(item, i + j)));
          }
        }

        state.output = results;
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return new Workflow<TContext, TInput, TNextOutput[]>([...this.steps, node] as any, this.id);
  }

  // ── repeat: conditional loop ─────────────────────────────────

  repeat(
    target: Agent<TContext, TOutput, TOutput> | SealedWorkflow<TContext, TOutput, TOutput>,
    options: RepeatOptions<TContext, TOutput>,
  ): Workflow<TContext, TInput, TOutput> {
    const maxIterations = options.maxIterations ?? 10;
    const isWorkflow = target instanceof SealedWorkflow;
    const id = isWorkflow ? (target.id ?? "repeat") : `repeat:${(target as Agent<TContext, TOutput, TOutput>).id}`;
    const predicate: LoopPredicate<TContext, TOutput> = options.until
      ?? (async (p) => !(await options.while!(p)));

    const node: StepNode = {
      type: "step",
      id,
      execute: async (state) => {
        const ctx = state.ctx as TContext;

        for (let i = 1; i <= maxIterations; i++) {
          if (isWorkflow) {
            await this.executeNestedWorkflow(state, target as SealedWorkflow<TContext, unknown, unknown>);
          } else {
            await this.executeAgent(state, target as Agent<TContext, TOutput, TOutput>, ctx);
          }

          const done = await predicate({
            output: state.output as TOutput,
            ctx: ctx as Readonly<TContext>,
            iterations: i,
          });
          if (done) return;
        }

        throw new WorkflowLoopError(maxIterations, maxIterations);
      },
    };
    return new Workflow<TContext, TInput, TOutput>([...this.steps, node], this.id);
  }

  // ── catch ─────────────────────────────────────────────────────

  catch(
    id: string,
    fn: (params: { error: unknown; ctx: Readonly<TContext>; lastOutput: TOutput; stepId: string }) => MaybePromise<TOutput>
  ): Workflow<TContext, TInput, TOutput> {
    if (!this.steps.some(s => s.type === "step")) {
      throw new Error(`Workflow: catch("${id}") requires at least one preceding step.`);
    }
    const node: StepNode = {
      type: "catch",
      id,
      catchFn: fn as (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>,
    };
    return new Workflow<TContext, TInput, TOutput>([...this.steps, node], this.id);
  }

  // ── finally (terminal — returns sealed workflow) ──────────────

  finally(
    id: string,
    fn: (params: { ctx: Readonly<TContext> }) => MaybePromise<void>
  ): SealedWorkflow<TContext, TInput, TOutput> {
    const node: StepNode = {
      type: "finally",
      id,
      execute: async (state) => {
        await fn({ ctx: state.ctx as Readonly<TContext> });
      },
    };
    return new SealedWorkflow<TContext, TInput, TOutput>([...this.steps, node], this.id);
  }
}

