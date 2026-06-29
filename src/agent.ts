import {
  generateText,
  streamText,
  tool,
  toUIMessageStream,
  Output,
  type GenerateTextResult as AIGenerateTextResult,
  type StreamTextResult as AIStreamTextResult,
  type UIMessageStreamWriter,
  type ModelMessage,
  type LanguageModel,
  type Tool,
  type ToolSet,
  type StopCondition,
  type ToolChoice,
  type GenerateTextStepEndEvent,
  type GenerateTextEndEvent,
} from "ai";

// Extract the Output interface type from the Output.object return type
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type OutputType<T = any> = ReturnType<typeof Output.object<T>>;
import type { ZodType } from "zod";
import { isToolProvider, TOOL_PROVIDER_BRAND, type IToolProvider } from "./tool-provider";
import { extractOutput, getActiveWriter, resolveValue, type MaybePromise, type Resolvable } from "./utils";

// Tools config accepts both AI SDK tools and context-aware ToolProviders
type AgentToolSet<TContext> = Record<string, Tool | IToolProvider<TContext>>;

// ── Result type aliases ─────────────────────────────────────────────

// AI SDK v7 gave GenerateTextResult/StreamTextResult/tool() a RUNTIME_CONTEXT /
// CONTEXT type param (the SDK's `Context`, which is `Record<string, unknown>` and is
// not exported by name). pipeai doesn't use SDK tool-context — it injects context via
// tool-providers — so we pin that slot to the base shape.
type SdkContext = Record<string, unknown>;

export type GenerateTextResult<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputType = OutputType> = AIGenerateTextResult<TOOLS, SdkContext, OUTPUT>;
export type StreamTextResult<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputType = OutputType> = AIStreamTextResult<TOOLS, SdkContext, OUTPUT>;

/**
 * The result passed to `asTool` / `asToolProvider`'s `mapOutput`.
 *
 * The same agent may be invoked as a tool from a generate-mode parent
 * (returns `GenerateTextResult`, sync `.text`/`.output`) or from a
 * stream-mode parent (returns `StreamTextResult`, async `.text`/`.output`).
 * The callsite cannot statically tell which mode it is in, so `mapOutput`
 * receives the union and must `await` the relevant fields to support both.
 */
export type AsToolMapOutput<TOutput> = (
  result:
    | GenerateTextResult<ToolSet, OutputType<TOutput>>
    | StreamTextResult<ToolSet, OutputType<TOutput>>,
) => MaybePromise<TOutput>;

// ── AI SDK passthrough types ────────────────────────────────────────

// Extract options types from both AI SDK entry points
type StreamTextOptions = Parameters<typeof streamText>[0];
type GenerateTextOptions = Parameters<typeof generateText>[0];

// Keys we replace with resolvable or context-enriched versions
// We omit both the v7 canonical keys (instructions/onEnd/onStepEnd) and their
// deprecated v6 aliases (system/onFinish/onStepFinish) so neither spelling leaks
// into the public passthrough surface and silently overrides a managed key.
type ManagedKeys =
  | 'model' | 'system' | 'instructions' | 'prompt' | 'messages'
  | 'tools' | 'activeTools' | 'toolChoice' | 'stopWhen'
  | 'output' | 'onFinish' | 'onEnd' | 'onStepFinish' | 'onStepEnd' | 'onError';

// Combine options from both streamText and generateText.
// Each side contributes its unique props; shared props merge naturally.
// Stream-only props (onChunk, onAbort) are ignored by generateText.
// Generate-only props (include.responseBody) are ignored by streamText.
type AIPassthroughOptions =
  Omit<StreamTextOptions, ManagedKeys> &
  Omit<GenerateTextOptions, ManagedKeys>;

// ── Resolved config (output of resolveConfig / resolveConfigAsync) ──

interface ResolvedAgentConfig {
  model: LanguageModel;
  prompt: string | undefined;
  instructions: string | undefined;
  messages: ModelMessage[] | undefined;
  tools: Record<string, Tool>;
  activeTools: string[] | undefined;
  toolChoice: ToolChoice<ToolSet> | undefined;
  stopWhen: StopCondition<ToolSet> | Array<StopCondition<ToolSet>> | undefined;
}

// ── Agent Configuration ─────────────────────────────────────────────

export interface AgentConfig<
  TContext,
  TInput = void,
  TOutput = void,
> extends AIPassthroughOptions {
  // ── Custom (not in AI SDK) ──
  id: string;
  description?: string;
  input?: ZodType<TInput>;
  output?: OutputType<TOutput>;
  /**
   * Zod schema used to validate `output` after the AI SDK returns. Distinct
   * from `tool.outputSchema` (AI SDK's tool-execution output schema): this
   * runs **after** the SDK has parsed structured output, as a runtime guard
   * against parse drift. If omitted, the parsed output is trusted as-is.
   */
  validateOutput?: ZodType<TOutput>;

  // ── Resolvable (our versions of AI SDK properties) ──
  model: Resolvable<TContext, TInput, LanguageModel>;
  instructions?: Resolvable<TContext, TInput, string>;
  prompt?: Resolvable<TContext, TInput, string>;
  messages?: Resolvable<TContext, TInput, ModelMessage[]>;
  tools?: Resolvable<TContext, TInput, AgentToolSet<TContext>>;
  activeTools?: Resolvable<TContext, TInput, string[]>;
  toolChoice?: Resolvable<TContext, TInput, ToolChoice<ToolSet>>;
  /**
   * Stop condition(s) for the tool loop. Pass either a single AI-SDK
   * `StopCondition` (which is itself a function) or an array of them.
   *
   * **Not a `Resolvable`.** A `StopCondition` and a `(ctx, input) => StopCondition`
   * resolver are both functions and cannot be safely distinguished at
   * runtime, so this field intentionally does NOT accept the resolver
   * form. If you need per-call dynamic stop conditions, build the agent
   * inside your handler instead of using a static instance.
   */
  stopWhen?: StopCondition<ToolSet> | Array<StopCondition<ToolSet>>;

  // ── Context-enriched callbacks (replace AI SDK versions) ──
  // `writer` is available when the agent runs inside a streaming workflow.
  onStepEnd?: (params: { result: GenerateTextStepEndEvent; ctx: Readonly<TContext>; input: TInput; writer?: UIMessageStreamWriter }) => MaybePromise<void>;
  onEnd?: (params: { result: GenerateTextEndEvent; ctx: Readonly<TContext>; input: TInput; writer?: UIMessageStreamWriter }) => MaybePromise<void>;
  onError?: (params: { error: unknown; ctx: Readonly<TContext>; input: TInput; writer?: UIMessageStreamWriter }) => MaybePromise<void>;
}

// ── AgentLike ───────────────────────────────────────────────────────

/**
 * The minimal surface a workflow step needs from an "agent": identity, whether
 * it produces structured output, an optional output validator, and the
 * `generate` / `stream` call methods. The {@link Agent} class implements this,
 * and `fromSdkAgent` adapts a Vercel AI SDK v7 agent (`ToolLoopAgent` or any
 * value implementing the SDK `Agent` interface) to it — so both can be passed
 * to `Workflow.step(...)`.
 */
export interface AgentLike<TContext, TInput = void, TOutput = void> {
  readonly id: string;
  readonly hasOutput: boolean;
  readonly validateOutput?: ZodType<TOutput>;
  generate(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: { abortSignal?: AbortSignal }]
      : [input: TInput, options?: { abortSignal?: AbortSignal }]
  ): Promise<GenerateTextResult<ToolSet, OutputType<TOutput>>>;
  stream(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: { abortSignal?: AbortSignal }]
      : [input: TInput, options?: { abortSignal?: AbortSignal }]
  ): Promise<StreamTextResult<ToolSet, OutputType<TOutput>>>;
}

// ── Agent ───────────────────────────────────────────────────────────

export class Agent<
  TContext,
  TInput = void,
  TOutput = void,
> implements AgentLike<TContext, TInput, TOutput> {
  readonly id: string;
  readonly description: string;
  readonly hasOutput: boolean;
  /**
   * Zod schema used to validate the agent's structured `output` after the AI
   * SDK returns. Distinct from `tool.outputSchema` (which validates tool
   * execution output). Exposed (readonly) so external runners — notably the
   * workflow runtime — can pass it through to `extractOutput` without
   * re-plumbing it.
   */
  readonly validateOutput: ZodType<TOutput> | undefined;
  private readonly config: AgentConfig<TContext, TInput, TOutput>;
  private readonly _hasDynamicConfig: boolean;
  private readonly _resolvedStaticTools: Record<string, Tool> | null = null;
  private readonly _passthrough: Record<string, unknown>;
  private readonly _onStepEnd: AgentConfig<TContext, TInput, TOutput>['onStepEnd'];
  private readonly _onEnd: AgentConfig<TContext, TInput, TOutput>['onEnd'];

  constructor(config: AgentConfig<TContext, TInput, TOutput>) {
    this.id = config.id;
    this.description = config.description ?? "";
    this.hasOutput = config.output !== undefined;
    this.validateOutput = config.validateOutput;
    this.config = config;
    // NOTE: `stopWhen` is intentionally excluded. A bare `StopCondition` is
    // itself a function (`({ steps }) => boolean`), so the typeof-function
    // resolver heuristic in `resolveValue` would misidentify it as a
    // `(ctx, input) => ...` Resolvable and call it with the wrong shape.
    // For `stopWhen` we always treat a function value as a static
    // StopCondition; dynamic stopWhen must return an array
    // (`(ctx, input) => [isStepCount(5)]`), which is the unambiguous form.
    this._hasDynamicConfig = [
      config.model, config.instructions, config.prompt,
      config.messages, config.tools, config.activeTools,
      config.toolChoice,
    ].some(v => typeof v === "function");

    // Cache tools when config is static and contains no ToolProviders.
    // Avoids re-iterating the tools map on every generate()/stream() call.
    if (!this._hasDynamicConfig) {
      const rawTools = (config.tools as AgentToolSet<TContext> | undefined) ?? {};
      const hasProvider = Object.values(rawTools).some(v => isToolProvider(v));
      if (!hasProvider) {
        this._resolvedStaticTools = rawTools as Record<string, Tool>;
      }
    }

    // Pre-compute the passthrough (AI SDK options we don't manage) once,
    // rather than destructuring on every generate()/stream() call.
    const {
      id: _id, description: _desc, input: _inputSchema, output: _output, validateOutput: _validateOutput,
      model: _m, instructions: _instr, prompt: _p, messages: _msg,
      tools: _t, activeTools: _at, toolChoice: _tc, stopWhen: _sw,
      onStepEnd, onEnd, onError: _onError,
      ...passthrough
    } = config;
    this._passthrough = passthrough;
    this._onStepEnd = onStepEnd;
    this._onEnd = onEnd;
  }

  async generate(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: { abortSignal?: AbortSignal }]
      : [input: TInput, options?: { abortSignal?: AbortSignal }]
  ): Promise<GenerateTextResult<ToolSet, OutputType<TOutput>>> {
    const input = args[0] as TInput;
    const callOptions = args[1] as { abortSignal?: AbortSignal } | undefined;
    return this.generateWithOptions(ctx, input, callOptions ?? {});
  }

  async stream(
    ctx: TContext,
    ...args: TInput extends void
      ? [input?: TInput, options?: { abortSignal?: AbortSignal }]
      : [input: TInput, options?: { abortSignal?: AbortSignal }]
  ): Promise<StreamTextResult<ToolSet, OutputType<TOutput>>> {
    const input = args[0] as TInput;
    const callOptions = args[1] as { abortSignal?: AbortSignal } | undefined;
    return this.streamWithOptions(ctx, input, callOptions ?? {});
  }

  asTool(ctx: TContext, options?: {
    mapOutput?: AsToolMapOutput<TOutput>;
  }): Tool {
    return this.createToolInstance(ctx, options);
  }

  asToolProvider(options?: {
    mapOutput?: AsToolMapOutput<TOutput>;
  }): IToolProvider<TContext> {
    if (!this.config.input) {
      throw new Error(`Agent "${this.id}": asToolProvider() requires an input schema`);
    }

    return {
      [TOOL_PROVIDER_BRAND]: true as const,
      createTool: (ctx: Readonly<TContext>) => this.createToolInstance(ctx as TContext, options),
    };
  }

  private createToolInstance(ctx: TContext, options?: {
    mapOutput?: AsToolMapOutput<TOutput>;
  }): Tool {
    if (!this.config.input) {
      throw new Error(`Agent "${this.id}": asTool() requires an input schema`);
    }

    return tool<TInput, TOutput, SdkContext>({
      description: this.description,
      inputSchema: this.config.input,
      // The AI SDK passes a `ToolExecutionOptions` argument that carries
      // `abortSignal`, `toolCallId`, `messages`, etc. Forward `abortSignal` so
      // a parent agent's abort cancels in-flight sub-agent calls instead of
      // leaving them running and producing detached output.
      execute: async (toolInput: TInput, execOptions?: { abortSignal?: AbortSignal }) => {
        const abortSignal = execOptions?.abortSignal;
        // When inside a streaming workflow, automatically use stream() and merge to the active writer.
        // Otherwise fall back to generate().
        const writer = getActiveWriter();
        if (writer) {
          const result = await this.streamWithOptions(ctx, toolInput, { abortSignal });
          writer.merge(toUIMessageStream({ stream: result.stream }));
          // Drain the text side to release the StreamTextResult anchor — the
          // writer.merge above only consumes the UI-message side, leaving
          // `result.text` pending until awaited.
          //
          // When mapOutput is provided, we explicitly do NOT call extractOutput
          // here: extractOutput throws if `hasOutput` is true but the model
          // returned no structured value, which would block any mapOutput that
          // wanted to recover from missing/malformed structured output by
          // reading `result.text`. mapOutput becomes the user's chance to do
          // their own extraction.
          if (options?.mapOutput) {
            await result.text;
            return options.mapOutput(result);
          }
          return extractOutput(result, this.hasOutput, this.validateOutput);
        }
        const result = await this.generateWithOptions(ctx, toolInput, { abortSignal });
        if (options?.mapOutput) return options.mapOutput(result);
        return extractOutput(result, this.hasOutput, this.validateOutput);
      },
      // TS cannot simplify the SDK's `NeverOptional<TOutput, ...>` conditional in a
      // generic context, so we cast through `unknown` instead of `any`.
    } as unknown as Tool<TInput, TOutput>);
  }

  // ── Internal: shared call helpers ─────────────────────────────
  // `generate()` / `stream()` and the `asTool()` wrapper all funnel through
  // these so the abortSignal-forwarding and onError-wrapping logic stays in
  // one place. `extra` carries per-call overrides (currently `abortSignal`).

  // If the user-supplied onError callback itself throws, attach the original
  // model error as `.cause` on the new error and rethrow the wrapper. Without
  // this, the original error is silently shadowed.
  private async invokeOnError(error: unknown, ctx: TContext, input: TInput): Promise<void> {
    if (!this.config.onError) return;
    try {
      await this.config.onError({ error, ctx, input, writer: getActiveWriter() });
    } catch (handlerError) {
      // Promote non-Error throws (`throw "boom"`, `throw 42`, etc.) so we
      // can chain the original error onto a real Error and keep diagnostics
      // intact. Re-throwing the raw non-Error value would drop the chain.
      if (handlerError instanceof Error) {
        if (handlerError.cause === undefined) {
          (handlerError as { cause?: unknown }).cause = error;
        }
        throw handlerError;
      }
      const wrapped = new Error(
        `Agent "${this.id}": onError handler threw a non-Error value (${typeof handlerError}): ${String(handlerError)}`,
      );
      (wrapped as { cause?: unknown }).cause = error;
      throw wrapped;
    }
  }

  private async generateWithOptions(
    ctx: TContext,
    input: TInput,
    extra: { abortSignal?: AbortSignal },
  ): Promise<GenerateTextResult<ToolSet, OutputType<TOutput>>> {
    const resolved = await this.resolveConfig(ctx, input);
    const options = this.buildCallOptions(resolved, ctx, input);
    try {
      // The SDK's `Output.object<T>` return type doesn't simplify generically
      // — cast through `unknown` rather than `any` so we keep the boundary
      // narrow without forcing the call site to know SDK option internals.
      return (await generateText({ ...options, ...extra } as unknown as Parameters<typeof generateText>[0])) as GenerateTextResult<ToolSet, OutputType<TOutput>>;
    } catch (error: unknown) {
      await this.invokeOnError(error, ctx, input);
      throw error;
    }
  }

  private async streamWithOptions(
    ctx: TContext,
    input: TInput,
    extra: { abortSignal?: AbortSignal },
  ): Promise<StreamTextResult<ToolSet, OutputType<TOutput>>> {
    const resolved = await this.resolveConfig(ctx, input);
    const options = this.buildCallOptions(resolved, ctx, input);
    try {
      // Only attach `onError` when the user supplied one. Setting it to
      // `undefined` explicitly suppresses some SDK versions' default
      // rethrow-on-partial-stream-error, silently swallowing stream failures.
      const onErrorOption = this.config.onError
        ? {
            onError: async ({ error }: { error: unknown }) => {
              // `invokeOnError` rethrows when the user's handler throws, to
              // preserve diagnostics. On the generate path that rethrow is
              // caught by the caller; here it would reject inside the SDK's
              // stream `onError` callback, which has no error channel and can
              // surface as an unhandled rejection. Catch it and surface the
              // failure (original chained as `cause`) so the intent isn't lost.
              try {
                await this.invokeOnError(error, ctx, input);
              } catch (handlerError) {
                // eslint-disable-next-line no-console
                console.error(`Agent "${this.id}": onError handler threw on the stream path:`, handlerError);
              }
            },
          }
        : {};
      return streamText({
        ...options,
        ...extra,
        ...onErrorOption,
      } as unknown as Parameters<typeof streamText>[0]) as StreamTextResult<ToolSet, OutputType<TOutput>>;
    } catch (error: unknown) {
      // streamText typically defers errors to the returned stream, but a
      // synchronous throw (e.g., invalid options) would otherwise bypass
      // onError entirely.
      await this.invokeOnError(error, ctx, input);
      throw error;
    }
  }

  private buildCallOptions(resolved: ResolvedAgentConfig, ctx: TContext, input: TInput): Record<string, unknown> {
    if (resolved.messages === undefined && resolved.prompt === undefined) {
      throw new Error(
        `Agent "${this.id}": neither \`prompt\` nor \`messages\` was provided. ` +
        `Configure one of them, or supply a Resolvable that returns one based on input.`,
      );
    }
    return {
      ...this._passthrough,
      model: resolved.model,
      tools: resolved.tools,
      activeTools: resolved.activeTools,
      toolChoice: resolved.toolChoice,
      stopWhen: resolved.stopWhen,
      ...(resolved.messages !== undefined
        ? { messages: resolved.messages }
        : { prompt: resolved.prompt }),
      // Use `!== undefined` rather than truthy so an intentional empty
      // `instructions: ""` survives instead of being silently dropped.
      ...(resolved.instructions !== undefined ? { instructions: resolved.instructions } : {}),
      ...(this.config.output ? { output: this.config.output } : {}),
      // Only attach the callback when the user supplied one. Passing
      // `undefined` explicitly can suppress default SDK rethrow behavior in
      // some versions.
      ...(this._onStepEnd
        ? { onStepEnd: (event: GenerateTextStepEndEvent) => this._onStepEnd!({ result: event, ctx, input, writer: getActiveWriter() }) }
        : {}),
      ...(this._onEnd
        ? { onEnd: (event: GenerateTextEndEvent) => this._onEnd!({ result: event, ctx, input, writer: getActiveWriter() }) }
        : {}),
    };
  }

  private resolveConfig(ctx: TContext, input: TInput): ResolvedAgentConfig | Promise<ResolvedAgentConfig> {
    if (!this._hasDynamicConfig) {
      return {
        model: this.config.model as LanguageModel,
        prompt: this.config.prompt as string | undefined,
        instructions: this.config.instructions as string | undefined,
        messages: this.config.messages as ModelMessage[] | undefined,
        tools: this._resolvedStaticTools ?? this.resolveTools(
          (this.config.tools as AgentToolSet<TContext> | undefined) ?? {}, ctx
        ),
        activeTools: this.config.activeTools as string[] | undefined,
        toolChoice: this.config.toolChoice as ToolChoice<ToolSet> | undefined,
        stopWhen: this.config.stopWhen as StopCondition<ToolSet> | Array<StopCondition<ToolSet>> | undefined,
      };
    }
    return this.resolveConfigAsync(ctx, input);
  }

  private async resolveConfigAsync(ctx: TContext, input: TInput): Promise<ResolvedAgentConfig> {
    const [model, prompt, instructions, messages, rawTools, activeTools, toolChoice] = await Promise.all([
      resolveValue(this.config.model, ctx, input),
      resolveValue(this.config.prompt, ctx, input),
      resolveValue(this.config.instructions, ctx, input),
      resolveValue(this.config.messages, ctx, input),
      resolveValue(this.config.tools, ctx, input),
      resolveValue(this.config.activeTools, ctx, input),
      resolveValue(this.config.toolChoice, ctx, input),
    ]);
    const tools = this.resolveTools(rawTools ?? {}, ctx);
    return {
      model,
      prompt,
      instructions,
      messages,
      tools,
      activeTools,
      toolChoice,
      // `stopWhen` is always static — see field declaration for why.
      stopWhen: this.config.stopWhen,
    };
  }

  private resolveTools(
    tools: AgentToolSet<TContext>,
    ctx: TContext
  ): Record<string, Tool> {
    const entries = Object.entries(tools);
    if (entries.length === 0) return tools as Record<string, Tool>;
    let hasProvider = false;
    const resolved: Record<string, Tool> = {};
    for (const [key, toolOrProvider] of entries) {
      if (isToolProvider<TContext>(toolOrProvider)) {
        hasProvider = true;
        resolved[key] = toolOrProvider.createTool(ctx as Readonly<TContext>);
      } else {
        resolved[key] = toolOrProvider as Tool;
      }
    }
    return hasProvider ? resolved : (tools as Record<string, Tool>);
  }
}
