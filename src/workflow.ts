import {
  createUIMessageStream,
  type UIMessageStreamWriter,
  type ToolSet,
} from "ai";
import { type Agent, type GenerateTextResult, type StreamTextResult, type OutputType } from "./agent";
import { extractOutput, runWithWriter, type MaybePromise } from "./utils";

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

// ── Gate / Snapshot Types ─────────────────────────────────────────────

/**
 * Snapshot of a workflow suspended at a gate.
 *
 * **JSON-safety contract.** The snapshot is intended to round-trip through
 * `JSON.stringify` / `JSON.parse`. The library does not deep-clone or
 * validate the contents of `output` or `gatePayload`. Values that aren't
 * JSON-safe (`Date`, `Map`, `Set`, `BigInt`, functions, class instances,
 * `undefined` in object positions) will either throw at serialize time or
 * mutate during the round-trip — make sure your pre-gate step and your
 * `gate.payload` callback produce plain JSON-serializable values.
 */
export interface WorkflowSnapshot<TPayload = unknown> {
  readonly version: 1;
  readonly resumeFromIndex: number;
  readonly output: unknown;
  readonly gateId: string;
  readonly gatePayload: TPayload;
}

export class WorkflowSuspended<TPayload = unknown> extends Error {
  readonly snapshot: WorkflowSnapshot<TPayload>;
  constructor(snapshot: WorkflowSnapshot<TPayload>) {
    super(`Workflow suspended at gate "${snapshot.gateId}"`);
    this.name = "WorkflowSuspended";
    this.snapshot = snapshot;
  }
}

// ── Shared Agent Step Hooks ─────────────────────────────────────────

export interface AgentStepHooks<TContext, TOutput, TNextOutput> {
  mapGenerateResult?: (params: { result: GenerateTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  mapStreamResult?: (params: { result: StreamTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
  onGenerateResult?: (params: { result: GenerateTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  onStreamResult?: (params: { result: StreamTextResult<ToolSet, OutputType<TNextOutput>>; ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<void>;
  handleStream?: (params: {
    result: StreamTextResult<ToolSet, OutputType<TNextOutput>>;
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
  agents: Record<TKeys, Agent<TContext, TOutput, TNextOutput>>;
  fallback?: Agent<TContext, TOutput, TNextOutput>;
  /**
   * Diagnostic hook invoked when `select` returns a key that has no matching
   * entry in `agents`. Fires BEFORE `fallback` is applied or
   * `WorkflowBranchError` is thrown, regardless of whether a `fallback` is
   * configured. Useful for logging typos / unexpected classifier output.
   */
  onUnknownKey?: (params: { key: string; availableKeys: TKeys[]; ctx: Readonly<TContext> }) => void;
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

// ── Schema type (structural — works with Zod, Valibot, ArkType, etc.) ──

interface SchemaWithParse<T = unknown> {
  parse(data: unknown): T;
}

// Wraps a user-supplied stream onError so `WorkflowSuspended` (control flow,
// not failure) is not surfaced as an error to the UI. The `output` promise
// still rejects with `WorkflowSuspended` so the caller can persist the
// snapshot; only the user-facing error stream is filtered.
function wrapStreamOnError(
  userOnError: (error: unknown) => string,
): (error: unknown) => string {
  return (error: unknown) => {
    if (error instanceof WorkflowSuspended) {
      // Returning empty string keeps the SDK happy; the consumer never sees
      // it because the UI message stream closes cleanly at the gate.
      return "";
    }
    return userOnError(error);
  };
}

// ── Step Node ───────────────────────────────────────────────────────

type StepNode =
  | { readonly type: "step"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> }
  | { readonly type: "catch"; readonly id: string; readonly catchFn: (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown> }
  | { readonly type: "finally"; readonly id: string; readonly execute: (state: RuntimeState) => MaybePromise<void> }
  | { readonly type: "gate"; readonly id: string; readonly payload: (state: RuntimeState) => MaybePromise<unknown>; readonly schema?: SchemaWithParse; readonly condition?: (state: RuntimeState) => MaybePromise<boolean>; readonly merge?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown> };

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
  TGates extends Record<string, unknown> = {},
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

    // Only suppress unhandled-rejection on `output` when the consumer has
    // attached `onError` to the stream — they're already observing through
    // that surface, so suppressing avoids a redundant warning. When no
    // `onError` is provided, we let `output`'s rejection surface as an
    // unhandled rejection rather than silently dropping it. Consumers who
    // ignore `output` should provide an `onError`.
    if (options?.onError) {
      outputPromise.catch(() => {});
    }

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
      ...(options?.onError ? { onError: wrapStreamOnError(options.onError) } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
    });

    return {
      stream,
      output: outputPromise,
    };
  }

  // ── Internal: execute pipeline ────────────────────────────────

  protected async execute(
    state: RuntimeState,
    startIndex: number = 0,
    initialError: { error: unknown; stepId: string } | null = null,
  ): Promise<void> {
    if (this.steps.length === 0) {
      throw new Error("Workflow has no steps. Add at least one step before calling generate() or stream().");
    }

    let pendingError: { error: unknown; stepId: string } | null = initialError;

    for (let i = startIndex; i < this.steps.length; i++) {
      const node = this.steps[i];

      if (node.type === "finally") {
        try {
          await node.execute(state);
        } catch (finallyError) {
          if (pendingError) {
            // Preserve the original error chain by attaching as .cause so
            // diagnostics aren't lost when cleanup itself fails.
            if (finallyError instanceof Error && finallyError.cause === undefined) {
              (finallyError as { cause?: unknown }).cause = pendingError.error;
            }
          }
          pendingError = { error: finallyError, stepId: node.id };
        }
        continue;
      }

      if (node.type === "catch") {
        if (!pendingError) continue;
        const priorError = pendingError.error;
        try {
          state.output = await node.catchFn({
            error: pendingError.error,
            ctx: state.ctx,
            lastOutput: state.output,
            stepId: pendingError.stepId,
          });
          pendingError = null;
        } catch (catchError) {
          // Preserve the original error chain via .cause when the catch
          // handler itself throws.
          if (catchError instanceof Error && catchError.cause === undefined) {
            (catchError as { cause?: unknown }).cause = priorError;
          }
          pendingError = { error: catchError, stepId: node.id };
        }
        continue;
      }

      if (node.type === "gate") {
        if (pendingError) continue; // skip gates while in error state
        try {
          // Conditional gate: if condition returns false, skip (passthrough)
          if (node.condition) {
            const shouldSuspend = await node.condition(state);
            if (!shouldSuspend) continue;
          }
          const gatePayload = await node.payload(state);
          throw new WorkflowSuspended({
            version: 1,
            resumeFromIndex: i,
            output: state.output,
            gateId: node.id,
            gatePayload,
          });
        } catch (error) {
          // WorkflowSuspended is the gate's own suspension signal — re-throw so
          // callers can capture the snapshot. User-callback errors (from
          // `condition` or `payload`) are captured into the workflow's
          // error pipeline so downstream `.catch()` handlers can recover.
          if (error instanceof WorkflowSuspended) throw error;
          pendingError = { error, stepId: node.id };
          continue;
        }
      }

      // type === "step" — skip while in error state
      if (pendingError) continue;

      try {
        await node.execute(state);
      } catch (error) {
        if (error instanceof WorkflowSuspended) throw error; // propagate, don't capture
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
    workflow: SealedWorkflow<TContext, unknown, unknown, any>,
  ): Promise<void> {
    try {
      await workflow.execute(state);
    } catch (error) {
      if (error instanceof WorkflowSuspended) {
        // Preserve the original WorkflowSuspended (and its snapshot) via
        // `.cause` so consumers who inspect the rejection can still recover
        // the gate information for diagnostics or future support.
        const wrapped = new Error(
          `Gates inside nested workflows are not yet supported. ` +
          `Gate "${error.snapshot.gateId}" was hit inside nested workflow "${workflow.id ?? "(anonymous)"}". ` +
          `Consider using a conditional gate with \`condition\` to skip when criteria are met, ` +
          `or restructure the workflow to use gates at the top level only.`
        );
        (wrapped as { cause?: unknown }).cause = error;
        throw wrapped;
      }
      throw error;
    }
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
      const writer = state.writer;
      // Run inside writer context so tools (asTool, defineTool) can access the writer automatically
      await runWithWriter(writer, async () => {
        const result = await (agent.stream as (ctx: TContext, input: unknown) => Promise<StreamTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output);

        if (options?.handleStream) {
          await options.handleStream({ result, writer, ctx });
        } else {
          writer.merge(result.toUIMessageStream());
        }

        if (options?.onStreamResult) {
          await options.onStreamResult({ result, ctx, input });
        }

        if (options?.mapStreamResult) {
          state.output = await options.mapStreamResult({ result, ctx, input });
        } else {
          state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
        }
      });
    } else {
      const result = await (agent.generate as (ctx: TContext, input: unknown) => Promise<GenerateTextResult<ToolSet, OutputType<TNextOutput>>>)(ctx, state.output);

      if (options?.onGenerateResult) {
        await options.onGenerateResult({ result, ctx, input });
      }

      if (options?.mapGenerateResult) {
        state.output = await options.mapGenerateResult({ result, ctx, input });
      } else {
        state.output = await extractOutput(result, hasStructuredOutput, agent.validateOutput);
      }
    }
  }

  // ── Gate: load persisted state for resumption ──────────────────

  loadState<K extends string & keyof TGates>(
    gateId: K,
    snapshot: WorkflowSnapshot,
  ): ResumedWorkflow<TContext, TGates[K], TOutput> {
    if (snapshot.gateId !== gateId) {
      throw new Error(
        `loadState: gate ID mismatch — expected "${gateId}" but snapshot has "${snapshot.gateId}".`
      );
    }
    const gateIndex = this.findGateIndex(snapshot);
    const gateNode = this.steps[gateIndex] as Extract<StepNode, { type: "gate" }>;
    return new ResumedWorkflow<TContext, TGates[K], TOutput>(
      this.steps,
      gateIndex + 1,
      gateNode.schema as SchemaWithParse<TGates[K]> | undefined,
      gateNode.merge,
      snapshot.output,
    );
  }

  private findGateIndex(snapshot: WorkflowSnapshot): number {
    if (snapshot.version !== 1) {
      throw new Error(`Unsupported snapshot version: ${snapshot.version}`);
    }

    // Fast path: check the hint index first (backward compat + O(1))
    const hint = snapshot.resumeFromIndex;
    if (hint >= 0 && hint < this.steps.length) {
      const node = this.steps[hint];
      if (node.type === "gate" && node.id === snapshot.gateId) {
        return hint;
      }
    }

    // Fallback: scan all steps by gate ID
    for (let i = 0; i < this.steps.length; i++) {
      const node = this.steps[i];
      if (node.type === "gate" && node.id === snapshot.gateId) {
        return i;
      }
    }

    throw new Error(
      `Gate "${snapshot.gateId}" not found in workflow. The workflow definition may have changed since the snapshot was created.`
    );
  }
}

// ── Resumed Workflow ──────────────────────────────────────────────────

export class ResumedWorkflow<
  TContext,
  TResponse = unknown,
  TOutput = void,
> extends SealedWorkflow<TContext, TResponse, TOutput> {
  private readonly startIndex: number;
  private readonly schema?: SchemaWithParse<TResponse>;
  private readonly mergeFn?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>;
  private readonly priorOutput: unknown;

  /** @internal */
  constructor(
    steps: ReadonlyArray<StepNode>,
    startIndex: number,
    schema?: SchemaWithParse<TResponse>,
    mergeFn?: (params: { priorOutput: unknown; response: unknown }) => MaybePromise<unknown>,
    priorOutput?: unknown,
  ) {
    super(steps);
    this.startIndex = startIndex;
    this.schema = schema;
    this.mergeFn = mergeFn;
    this.priorOutput = priorOutput;
  }

  private validateResponse(response: TResponse): TResponse {
    if (this.schema) {
      return this.schema.parse(response);
    }
    return response;
  }

  override async generate(
    ctx: TContext,
    ...args: TResponse extends void ? [response?: TResponse] : [response: TResponse]
  ): Promise<WorkflowResult<TOutput>> {
    // Run prep (schema.parse + mergeFn) inside the workflow error pipeline so
    // a downstream `.catch()` can observe failures here. Without this,
    // the schema/merge throw would reject the promise raw, bypassing catch.
    let output: unknown = this.priorOutput;
    let initialError: { error: unknown; stepId: string } | null = null;
    try {
      const response = this.validateResponse(args[0] as TResponse);
      output = this.mergeFn
        ? await this.mergeFn({ priorOutput: this.priorOutput, response })
        : response;
    } catch (error) {
      initialError = { error, stepId: "gate:resume" };
    }
    const state: RuntimeState = { ctx, output, mode: "generate" };
    await this.execute(state, this.startIndex, initialError);
    return { output: state.output as TOutput };
  }

  override stream(
    ctx: TContext,
    ...args: TResponse extends void
      ? [response?: TResponse, options?: WorkflowStreamOptions]
      : [response: TResponse, options?: WorkflowStreamOptions]
  ): WorkflowStreamResult<TOutput> {
    const rawResponse = args[0] as TResponse;
    const options = args[1] as WorkflowStreamOptions | undefined;

    let resolveOutput: (value: TOutput) => void;
    let rejectOutput: (error: unknown) => void;
    const outputPromise = new Promise<TOutput>((res, rej) => {
      resolveOutput = res;
      rejectOutput = rej;
    });
    // See SealedWorkflow.stream: only suppress unhandled-rejection when the
    // consumer is observing errors through `onError`.
    if (options?.onError) {
      outputPromise.catch(() => {});
    }

    const mergeFn = this.mergeFn;
    const priorOutput = this.priorOutput;

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Run prep (schema.parse AND mergeFn) inside the workflow error
        // pipeline so a downstream `.catch()` can observe failures here.
        // Without this, a schema.parse throw escapes synchronously from
        // .stream(...) and bypasses the workflow's catch nodes entirely.
        let output: unknown = priorOutput;
        let initialError: { error: unknown; stepId: string } | null = null;
        try {
          const response = this.validateResponse(rawResponse);
          const merged = mergeFn ? await mergeFn({ priorOutput, response }) : response;
          output = merged;
        } catch (error) {
          initialError = { error, stepId: "gate:resume" };
        }
        const state: RuntimeState = {
          ctx,
          output,
          mode: "stream",
          writer,
        };

        try {
          await this.execute(state, this.startIndex, initialError);
          resolveOutput(state.output as TOutput);
        } catch (error) {
          rejectOutput!(error);
          throw error;
        }
      },
      ...(options?.onError ? { onError: wrapStreamOnError(options.onError) } : {}),
      ...(options?.onFinish ? { onFinish: options.onFinish } : {}),
    });

    return { stream, output: outputPromise };
  }
}

// ── Workflow ────────────────────────────────────────────────────────

export class Workflow<
  TContext,
  TInput = void,
  TOutput = void,
  TGates extends Record<string, unknown> = {},
> extends SealedWorkflow<TContext, TInput, TOutput, TGates> {

  /**
   * Sentinel value for `foreach`'s `onError` handler. Returning `Workflow.SKIP`
   * from `onError` omits the failed item's index from the output array,
   * shortening it relative to the input array.
   */
  static readonly SKIP: unique symbol = Symbol("pipeai.foreach.skip");

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
    // An empty workflow's TOutput is TInput (passthrough), and `.step` then
    // transitions it to TOutput. No `any` needed here — the cast was a relic.
    return new Workflow<TContext, TInput, TInput>([]).step(agent, options);
  }

  // ── step: agent overload ──────────────────────────────────────

  step<TNextOutput>(
    agent: Agent<TContext, TOutput, TNextOutput>,
    options?: StepOptions<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: nested workflow overload ─────────────────────────────

  step<TNextOutput>(
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: nested workflow with explicit id overload ───────────

  step<TNextOutput>(
    id: string,
    workflow: SealedWorkflow<TContext, TOutput, TNextOutput>,
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: transform overload (replaces map + tap) ─────────────

  step<TNextOutput>(
    id: string,
    fn: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── step: implementation ──────────────────────────────────────

  step<TNextOutput>(
    target: Agent<TContext, TOutput, TNextOutput> | SealedWorkflow<TContext, TOutput, TNextOutput> | string,
    optionsOrFnOrWorkflow?:
      | StepOptions<TContext, TOutput, TNextOutput>
      | ((params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>)
      | SealedWorkflow<TContext, TOutput, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    // Nested workflow overload: step(workflow)
    if (target instanceof SealedWorkflow) {
      const workflow = target;
      const node: StepNode = {
        type: "step",
        id: workflow.id ?? "nested-workflow",
        execute: async (state) => {
          await this.executeNestedWorkflow(state, workflow as SealedWorkflow<TContext, unknown, unknown, any>);
        },
      };
      return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
    }

    if (typeof target === "string") {
      // Nested workflow with explicit id overload: step(id, workflow)
      if (optionsOrFnOrWorkflow instanceof SealedWorkflow) {
        const workflow = optionsOrFnOrWorkflow;
        const node: StepNode = {
          type: "step",
          id: target,
          execute: async (state) => {
            await this.executeNestedWorkflow(state, workflow as SealedWorkflow<TContext, unknown, unknown, any>);
          },
        };
        return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
      }

      // Transform overload: step(id, fn)
      if (typeof optionsOrFnOrWorkflow !== "function") {
        throw new Error(`Workflow step("${target}"): second argument must be a function or SealedWorkflow`);
      }
      const fn = optionsOrFnOrWorkflow as (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<TNextOutput>;
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
      return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
    }

    // Agent overload: step(agent, options?)
    const agent = target;
    const options = optionsOrFnOrWorkflow as StepOptions<TContext, TOutput, TNextOutput> | undefined;
    const node: StepNode = {
      type: "step",
      id: agent.id,
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        await this.executeAgent(state, agent, ctx, options);
      },
    };
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
  }

  // ── gate: human-in-the-loop suspension point ────────────────

  gate<TResponse = TOutput, Id extends string = string, TMerged = TResponse>(
    id: Id & (Id extends keyof TGates ? never : Id),
    options?: {
      payload?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<unknown>;
      schema?: SchemaWithParse<TResponse>;
      condition?: (params: { ctx: Readonly<TContext>; input: TOutput }) => MaybePromise<boolean>;
      merge?: (params: { priorOutput: TOutput; response: TResponse }) => MaybePromise<TMerged>;
    }
  ): Workflow<TContext, TInput, TMerged, TGates & Record<Id, TResponse>> {
    if (this.steps.some(s => s.type === "gate" && s.id === id)) {
      throw new Error(`Workflow: duplicate gate ID "${id}". Each gate must have a unique identifier.`);
    }
    const node: StepNode = {
      type: "gate",
      id,
      schema: options?.schema,
      condition: options?.condition
        ? async (state) => options.condition!({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          })
        : undefined,
      merge: options?.merge
        ? (params) => options.merge!(params as { priorOutput: TOutput; response: TResponse }) as MaybePromise<unknown>
        : undefined,
      payload: async (state) => {
        if (options?.payload) {
          return options.payload({
            ctx: state.ctx as Readonly<TContext>,
            input: state.output as TOutput,
          });
        }
        return state.output;
      },
    };
    return new Workflow<TContext, TInput, TMerged, TGates & Record<Id, TResponse>>([...this.steps, node], this.id);
  }

  // ── branch: predicate routing (array) ─────────────────────────

  branch<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[]
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── branch: key routing (select) ──────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates>;

  // ── branch: implementation ────────────────────────────────────

  branch<TKeys extends string, TNextOutput>(
    casesOrConfig: BranchCase<TContext, TOutput, TNextOutput>[] | BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    if (Array.isArray(casesOrConfig)) {
      return this.branchPredicate(casesOrConfig);
    }
    return this.branchSelect(casesOrConfig);
  }

  private branchPredicate<TNextOutput>(
    cases: BranchCase<TContext, TOutput, TNextOutput>[]
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
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
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
  }

  private branchSelect<TKeys extends string, TNextOutput>(
    config: BranchSelect<TContext, TOutput, TKeys, TNextOutput>
  ): Workflow<TContext, TInput, TNextOutput, TGates> {
    const node: StepNode = {
      type: "step",
      id: "branch:select",
      execute: async (state) => {
        const ctx = state.ctx as TContext;
        const input = state.output as TOutput;
        const key = await config.select({ ctx, input });

        // Distinguish "key not declared at all" from "key present but value
        // is `undefined`" (e.g. `agents: { bug: cond ? agentA : undefined }`).
        // The latter is a user-side bug — fail loud rather than silently
        // falling back, since the fallback obscures the misconfiguration.
        //
        // Use Object.hasOwn (not `in`) so untrusted classifier output like
        // "toString" / "constructor" / "__proto__" doesn't resolve to a
        // Object.prototype method and crash executeAgent.
        const keyDeclared = Object.prototype.hasOwnProperty.call(config.agents, key);
        if (keyDeclared && config.agents[key] === undefined) {
          throw new WorkflowBranchError(
            "select",
            `Agent for key "${key}" was declared but the value is undefined. ` +
            `This usually means a conditional spread set the value to undefined. ` +
            `Available keys: ${Object.keys(config.agents).join(", ")}`,
          );
        }
        let agent = keyDeclared ? config.agents[key] : undefined;
        if (!agent) {
          if (config.onUnknownKey) {
            config.onUnknownKey({
              key,
              availableKeys: Object.keys(config.agents) as TKeys[],
              ctx: ctx as Readonly<TContext>,
            });
          }
          if (config.fallback) {
            agent = config.fallback;
          } else {
            throw new WorkflowBranchError("select", `No agent found for key "${key}" and no fallback provided. Available keys: ${Object.keys(config.agents).join(", ")}`);
          }
        }

        await this.executeAgent(state, agent, ctx, config);
      },
    };
    return new Workflow<TContext, TInput, TNextOutput, TGates>([...this.steps, node], this.id);
  }

  // ── foreach: array iteration ─────────────────────────────────

  /**
   * Map each item of an array through an agent or sub-workflow.
   *
   * @param target Agent or `SealedWorkflow` invoked once per item.
   * @param options.concurrency Max items in flight at any moment (default 1).
   *   Backed by a semaphore: as soon as one item completes, the next launches —
   *   no lockstep batching.
   * @param options.onError Per-iteration error handler. When provided, a single
   *   item's failure no longer aborts the foreach. Return a `TNextOutput` value
   *   to substitute for the failed item, return `Workflow.SKIP` to omit the
   *   index (shortening the output array), or throw / return a rejected promise
   *   to abort the foreach step (the thrown error is caught by any downstream
   *   `.catch()`). When omitted, the existing fail-fast behavior is preserved.
   *   `onError` is invoked sequentially in index order after all items settle.
   *
   *   **All-or-nothing recovery under `concurrency > 1`:** when `concurrency > 1`
   *   and any `onError` handler throws, the entire foreach aborts — any
   *   successful recoveries from other items are NOT preserved (results are
   *   discarded with the thrown `AggregateError`). Use `concurrency: 1` if you
   *   need partial-recovery semantics where a handler-failure on item N
   *   doesn't discard recoveries on items 0..N-1.
   */
  foreach<TNextOutput>(
    target: Agent<TContext, ElementOf<TOutput>, TNextOutput> | SealedWorkflow<TContext, ElementOf<TOutput>, TNextOutput>,
    options?: {
      concurrency?: number;
      onError?: (params: {
        error: unknown;
        item: ElementOf<TOutput>;
        index: number;
        ctx: Readonly<TContext>;
      }) => MaybePromise<TNextOutput | typeof Workflow.SKIP>;
    },
  ): Workflow<TContext, TInput, TNextOutput[], TGates> {
    const concurrency = options?.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error(
        `Workflow.foreach: concurrency must be a positive finite integer (got ${concurrency}). ` +
        `Use 1 for sequential, or a finite cap for parallelism.`,
      );
    }
    const onError = options?.onError;
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
        const skipped = new Set<number>();

        // Streaming is intentionally not propagated to foreach items —
        // each item runs in generate mode because merging interleaved
        // streams from parallel items into a single writer is not supported.
        const executeItem = async (item: unknown, index: number) => {
          const itemState: RuntimeState = { ctx: state.ctx, output: item, mode: "generate" };
          if (isWorkflow) {
            await this.executeNestedWorkflow(itemState, target as SealedWorkflow<TContext, unknown, unknown, any>);
          } else {
            await this.executeAgent(itemState, target as Agent<TContext, unknown, TNextOutput>, ctx);
          }
          results[index] = itemState.output;
        };

        const handleRejection = async (error: unknown, item: unknown, index: number) => {
          if (!onError) throw error;
          const recovered = await onError({
            error,
            item: item as ElementOf<TOutput>,
            index,
            ctx: state.ctx as Readonly<TContext>,
          });
          if (recovered === Workflow.SKIP) {
            skipped.add(index);
          } else {
            results[index] = recovered;
          }
        };

        if (concurrency <= 1) {
          for (let i = 0; i < items.length; i++) {
            try {
              await executeItem(items[i], i);
            } catch (error) {
              await handleRejection(error, items[i], i);
            }
          }
        } else {
          const failures: Array<{ index: number; error: unknown }> = [];
          let nextIndex = 0;

          // Worker-pool: spawn at most `concurrency` workers, each pulls the next
          // index from a shared counter. Memory is O(concurrency), not
          // O(items.length), because we don't pre-allocate one async closure per
          // item. Failures are buffered and processed in index order AFTER all
          // workers settle so onError invocations remain deterministic.
          const worker = async () => {
            while (true) {
              const i = nextIndex++;
              if (i >= items.length) return;
              try {
                await executeItem(items[i], i);
              } catch (error) {
                failures.push({ index: i, error });
              }
            }
          };

          const workers = Array.from(
            { length: Math.min(concurrency, items.length) },
            () => worker(),
          );
          await Promise.all(workers);

          failures.sort((a, b) => a.index - b.index);

          if (!onError) {
            // No recovery handler: aggregate all failures so none are silently dropped.
            if (failures.length === 1) throw failures[0].error;
            if (failures.length > 1) {
              throw new AggregateError(
                failures.map(f => f.error),
                `foreach "${id}": ${failures.length} of ${items.length} items failed`,
              );
            }
          } else {
            // With onError: invoke for every failure, collecting any onError-throws
            // as a secondary AggregateError so no handler error is silently dropped.
            const handlerErrors: unknown[] = [];
            for (const { index, error } of failures) {
              try {
                await handleRejection(error, items[index], index);
              } catch (handlerError) {
                handlerErrors.push(handlerError);
              }
            }
            if (handlerErrors.length === 1) throw handlerErrors[0];
            if (handlerErrors.length > 1) {
              throw new AggregateError(
                handlerErrors,
                `foreach "${id}": ${handlerErrors.length} onError handlers threw (all results discarded)`,
              );
            }
          }
        }

        state.output = skipped.size === 0
          ? results
          : results.filter((_, i) => !skipped.has(i));
      },
    };
    return new Workflow<TContext, TInput, TNextOutput[], TGates>([...this.steps, node], this.id);
  }

  // ── repeat: conditional loop ─────────────────────────────────

  /**
   * Iterates `target` until/while a predicate. Predicate runs AFTER each
   * iteration, so `repeat(agent, { while: () => false })` still executes once
   * (do-while semantics, not while semantics). The body runs at minimum once.
   *
   * @param target Agent or SealedWorkflow whose output type matches its input type.
   * @param options.until Stop when predicate returns true. The predicate sees
   *   the iteration count starting at 1 (after the first run).
   * @param options.while Continue while predicate returns true. Same semantics —
   *   evaluated AFTER the body, so this is do-while, not while.
   * @param options.maxIterations Safety cap (default 10). Throws WorkflowLoopError.
   */
  repeat(
    target: Agent<TContext, TOutput, TOutput> | SealedWorkflow<TContext, TOutput, TOutput>,
    options: RepeatOptions<TContext, TOutput>,
  ): Workflow<TContext, TInput, TOutput, TGates> {
    // Defensive runtime checks. TS already enforces the until-XOR-while shape,
    // but callers using `as any` / dynamic config can still bypass it.
    const hasUntil = typeof options.until === "function";
    const hasWhile = typeof options.while === "function";
    if (hasUntil === hasWhile) {
      throw new Error(
        `Workflow.repeat: exactly one of \`until\` or \`while\` must be provided ` +
        `(got ${hasUntil && hasWhile ? "both" : "neither"}).`,
      );
    }
    const maxIterations = options.maxIterations ?? 10;
    if (!Number.isInteger(maxIterations) || maxIterations < 1) {
      throw new Error(
        `Workflow.repeat: maxIterations must be a positive finite integer (got ${maxIterations}). ` +
        `The body always runs at least once (do-while semantics).`,
      );
    }
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
            await this.executeNestedWorkflow(state, target as SealedWorkflow<TContext, unknown, unknown, any>);
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
    return new Workflow<TContext, TInput, TOutput, TGates>([...this.steps, node], this.id);
  }

  // ── catch ─────────────────────────────────────────────────────

  catch(
    id: string,
    fn: (params: { error: unknown; ctx: Readonly<TContext>; lastOutput: TOutput; stepId: string }) => MaybePromise<TOutput>
  ): Workflow<TContext, TInput, TOutput, TGates> {
    // Anything that can throw (step OR gate) makes catch meaningful. Gates can
    // throw from `condition`/`payload`/`merge` callbacks which the runtime
    // routes into the catch pipeline (see SealedWorkflow.execute gate branch).
    if (!this.steps.some(s => s.type === "step" || s.type === "gate")) {
      throw new Error(
        `Workflow: catch("${id}") requires at least one preceding step or gate.`,
      );
    }
    const node: StepNode = {
      type: "catch",
      id,
      catchFn: fn as (params: { error: unknown; ctx: unknown; lastOutput: unknown; stepId: string }) => MaybePromise<unknown>,
    };
    return new Workflow<TContext, TInput, TOutput, TGates>([...this.steps, node], this.id);
  }

  // ── finally (terminal — returns sealed workflow) ──────────────

  finally(
    id: string,
    fn: (params: { ctx: Readonly<TContext> }) => MaybePromise<void>
  ): SealedWorkflow<TContext, TInput, TOutput, TGates> {
    const node: StepNode = {
      type: "finally",
      id,
      execute: async (state) => {
        await fn({ ctx: state.ctx as Readonly<TContext> });
      },
    };
    return new SealedWorkflow<TContext, TInput, TOutput, TGates>([...this.steps, node], this.id);
  }
}

